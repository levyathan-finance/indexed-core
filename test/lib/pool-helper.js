const { calcSpotPrice, calcOutGivenIn, calcSingleInGivenPoolOut, calcInGivenOut, calcInGivenPrice } = require("./calc_comparisons");
const { default: Decimal } = require("decimal.js");

module.exports = class PoolHelper {
  /* token objects should have { address, price, totalSupply, balance } */
  /* numbers should be js numbers in standard format, i.e. 10 instead of 1e19 */
  constructor(token_objects, swapFee, blockTimestamp) {
    this.swapFee = swapFee;
    this.timestamp = blockTimestamp;
    this.tokens = [];
    this.records = {};
    this.marketCaps = {};
    this.poolSupply = Decimal(100);
    this.size = token_objects.length;
    for (let token of token_objects) {
      const { address, price, totalSupply, balance } = token;
      this.tokens.push(address);
      this.records[address] = {
        balance,
        marketCap: totalSupply * price,
        lastDenormUpdate: blockTimestamp,
        totalSupply: Decimal(totalSupply),
        price,
        ready: true
      }
    }
    this.setDesiredWeights();
    for (let token of this.tokens) {
      const record = this.records[token];
      record.denorm = record.desiredDenorm;
    }
  }

  getTotalValue() {
    const [token] = this.tokens;
    const { balance, price, denorm } = this.records[token];
    return (this.totalWeight / denorm) * balance * price;
  }

  addToken(tokenObj) {
    const { totalSupply, address, price } = tokenObj;
    this.tokens.push(address);
    this.records[address] = {
      balance: 0,
      marketCap: totalSupply * price,
      totalSupply,
      price,
      ready: false
    };
    this.setDesiredWeights();
    const totalValue = this.getTotalValue();
    this.records[address].minimumBalance = Decimal((totalValue / 100) / price);
  }

  getSortedRecords() {
    const records = this.tokens.map(t => ({ ...this.records[t], address: t }));
    records.map(r => (r.marketCap = Decimal(r.totalSupply).mul(r.price)));
    records.sort((a, b) => (+(a.marketCap) < +(b.marketCap)) ? 1 : -1);
    return records;
  }

  setDesiredWeights() {
    // const marketCaps = this.tokens.map(a => {
    //   const { totalSupply, price } = this.records[a];
    //   return (this.records[a].marketCap = Decimal(totalSupply).mul(price));
    // });
    // marketCaps.sort((a, b) => (+a < +b) ? 1 : -1);
    let records = this.getSortedRecords();
    if (records.length > this.size) {
      const removed = records.splice(this.size);
      for (let r of removed) {
        this.records[r.address].desiredDenorm = 0;
      }
    }
    const marketCaps = records.map(r => r.marketCap);
    const marketCapSqrts = marketCaps.map(m => Math.sqrt(+m));
    const sqrtSum = marketCapSqrts.reduce((a, b) => a + b, 0);
    let weights = marketCapSqrts.map(m => 25 * m / sqrtSum);
    this.totalWeight = weights.reduce((a, b) => a+b, 0);
    for (let i = 0; i < records.length; i++) {
      let a = records[i].address;
      this.records[a].desiredDenorm = weights[i];
    }
  }

  updateWeights() {
    for (let address of this.tokens) this.updateWeight(address)
  }

  calcWeightIncrease(address) {
    const record = this.records[address];
    let oldWeight = record.denorm;
    let desiredDenorm = record.desiredDenorm;
    if (oldWeight >= desiredDenorm) return oldWeight;
    let denorm = desiredDenorm;
    const maxDiff = oldWeight * 0.01;
    let diff = desiredDenorm - oldWeight;
    if (diff > maxDiff) denorm = oldWeight + maxDiff;
    return denorm;
  }

  calcWeightDecrease(address) {
    const record = this.records[address];
    const oldWeight = record.denorm;
    const desiredDenorm = record.desiredDenorm;
    if (oldWeight <= desiredDenorm) return oldWeight;
    let denorm = desiredDenorm;
    const maxDiff = oldWeight * 0.01;
    const diff = oldWeight - desiredDenorm;
    if (diff > maxDiff) denorm = oldWeight - maxDiff;
    return denorm;
  }

  setBlockTimestamp(blockTimestamp) {
    this.timestamp = blockTimestamp;
  }

  calcSpotPrice(tokenIn, tokenOut) {
    const { denorm: dI, balance: bI } = this.records[tokenIn];
    const { denorm: dO, balance: bO } = this.records[tokenOut];
    return calcSpotPrice(bI, dI, bO, dO, this.swapFee);
  }

  calcOutGivenIn(tokenIn, tokenOut, amountIn, updateWeightAfter = false, saveUpdate = false) {
    let { denorm: dI, balance: bI, ready: rI, realBalance: rbI } = this.getInputToken(tokenIn);
    let { denorm: dO, balance: bO, ready: rO } = this.records[tokenOut];
    if (!rO) throw new Error('Out token not ready.');
    let tokenAmountOut = calcOutGivenIn(bI, dI, bO, dO, amountIn, this.swapFee);
    tokenAmountOut = tokenAmountOut.toNumber();
    if (amountIn > bI / 2) throw new Error('Exceeds max in ratio');
    if (tokenAmountOut > bO / 3) throw new Error('Exceeds max out ratio');
    rbI = rbI + (+amountIn);
    
    if (updateWeightAfter) {
      const { ready, denorm, balance, realBalance } = this.updateTokenIn({
        address: tokenIn,
        balance: bI,
        ready: rI,
        denorm: dI,
        realBalance: rbI
      });
      if (ready) {
        bI = realBalance;
      } else {
        bI = balance;
      }
      dI = denorm;
      rI = ready;
      dO = this.calcWeightDecrease(tokenOut);
    } else {
      bI = rbI;
    }
    bO = bO - tokenAmountOut;
    const spotPriceAfter = calcSpotPrice(
      bI,
      dI,
      bO,
      dO,
      this.swapFee
    );
    if (saveUpdate) {
      this.records[tokenIn].balance = rbI;
      this.records[tokenOut].balance = bO;
      this.records[tokenOut].denorm = dO;
      if (rI) {
        this.records[tokenIn].denorm = dI;
        this.records[tokenIn].ready = true;
      }
    }
    return [tokenAmountOut, spotPriceAfter];
  }

  getInputToken(token) {
    const minWeight = 0.25;
    let { denorm: dI, balance: bI, ready: rI, minimumBalance: mbI } = this.records[token];
    let rbI = +bI;
    let balance = rbI;
    let denorm = +dI;
    mbI = +mbI;

    if (!rI) {
      const realToMinRatio = ((mbI) - (rbI)) / (mbI);
      const premium = (realToMinRatio) * (minWeight / 10);
      denorm = minWeight + premium;
      balance = mbI;
    }
    return { balance, denorm, realBalance: rbI, ready: rI };
  }

  updateTokenIn({ address, balance, ready, denorm, realBalance }) {
    const minWeight = 0.25;
    if (!ready) {
      if (realBalance >= balance) {
        ready = true;
        const additionalBalance = realBalance - balance;
        const balRatio = additionalBalance / balance;
        denorm = minWeight + (minWeight * balRatio);
        return { ready, denorm, balance, realBalance };
      } else {
        const realToMinRatio = (balance - realBalance) / balance;
        // (Decimal(balance).minus(Decimal(realBalance))).div(Decimal(balance));
        const weightPremium = (minWeight / 10) * realToMinRatio;
        denorm = minWeight + weightPremium;
        return { ready, denorm, balance, realBalance }
      }
    } else {
      return {
        balance,
        ready,
        denorm: this.calcWeightIncrease(address),
        realBalance
      }
    }
  }

  calcInGivenOut(tokenIn, tokenOut, tokenAmountOut, updateWeightAfter = false) {
    let { denorm: dI, balance: bI, ready: rI, realBalance: rbI } = this.getInputToken(tokenIn);
    let { denorm: dO, balance: bO, ready: rO } = this.records[tokenOut];
    if (!rO) throw new Error('Out token not ready.');
    let amountIn = calcInGivenOut(bI, dI, bO, dO, tokenAmountOut, this.swapFee);
    amountIn = (+amountIn);
    if (amountIn > bI / 2) throw new Error('Exceeds max in ratio');
    if (tokenAmountOut > bO / 3) throw new Error('Exceeds max out ratio');
    rbI = rbI + amountIn;
    
    if (updateWeightAfter) {
      const { ready, denorm, balance, realBalance } = this.updateTokenIn({
        address: tokenIn,
        balance: bI,
        ready: rI,
        denorm: dI,
        realBalance: rbI
      });
      if (ready) {
        bI = realBalance;
      } else {
        bI = balance;
      }
      dI = denorm;
      rI = ready;
      dO = this.calcWeightDecrease(tokenOut);
    } else {
      bI = rbI;
    }
    bO = bO - tokenAmountOut;
    
    const spotPriceAfter = calcSpotPrice(
      bI,
      dI,
      bO,
      dO,
      this.swapFee
    );
    return [Decimal(amountIn), spotPriceAfter];
  }

  calcSpotPrice(tokenIn, tokenOut) {
    const { balance: bI, denorm: dI } = this.getInputToken(tokenIn);
    const { denorm: dO, balance: bO } = this.records[tokenOut];
    return calcSpotPrice(+bI, +dI, +bO, +dO, this.swapFee);
  }
  
  calcPoolOutGivenSingleIn(tokenIn, tokenAmountIn) {
    const { denorm: dI, balance: bI } = this.records[tokenIn];
    return calcPoolOutGivenSingleIn(bI, dI, this.poolSupply, this.totalWeight, tokenAmountIn, this.swapFee);
  }

  calcSingleInGivenPoolOut(tokenIn, poolAmountOut) {
    const { denorm: dI, balance: bI } = this.records[tokenIn];
    return calcSingleInGivenPoolOut(bI, dI, this.poolSupply, this.totalWeight, poolAmountOut, this.swapFee);
  }

  calcInGivenPrice(tokenIn, tokenOut, extPrice) {
    const { balance: bI, denorm: dI } = this.getInputToken(tokenIn);
    const { denorm: dO, balance: bO } = this.records[tokenOut];
    return calcInGivenPrice(
      +bI,
      +dI,
      +bO,
      +dO,
      +extPrice,
      this.swapFee
    )
  }
}