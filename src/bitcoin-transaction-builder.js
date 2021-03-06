var async = require('async')
var bitcoin = require('bitcoinjs-lib')
var txHexToJSON = require('bitcoin-tx-hex-to-json')

var dataPayload = require('./data-payload')

var OP_RETURN_BUFFER = new Buffer(1)
OP_RETURN_BUFFER.writeUInt8(bitcoin.opcodes.OP_RETURN, 0)

var loadAndSignTransaction = function (options, callback) {
  var tx = options.tx
  var address = options.address
  var fee = options.fee
  var destinationValue = options.destinationValue || 0
  var unspentOutputs = options.unspentOutputs
  var unspentValue = 0
  var compare = function (a, b) {
    if (a.value < b.value) {
      return -1
    }
    if (a.value > b.value) {
      return 1
    }
    return 0
  }
  unspentOutputs.sort(compare)
  var txInputIndex = tx.inputs.length
  for (var i = unspentOutputs.length - 1; i >= 0; i--) {
    var unspentOutput = unspentOutputs[i]
    if (unspentOutput.value === 0) {
      continue
    }
    unspentValue += unspentOutput.value
    tx.addInput(unspentOutput.txid, unspentOutput.vout)
  }
  var change = unspentValue - fee - destinationValue
  tx.addOutput(address, change)
  if (options.skipSign) {
    return callback(false, tx)
  }
  options.signTransaction(tx, txInputIndex, function (err, signedTx) {
    if (err) { } // TODO
    callback(false, signedTx)
  })
}

var getPrimaryTransactions = function (transactions) {
  var primaryTransactions = []
  for (var i = 0; i < transactions.length; i++) {
    var transactionHex = transactions[i]
    var transaction = txHexToJSON(transactionHex)
    var vout = transaction.vout
    for (var j = vout.length - 1; j >= 0; j--) {
      var output = vout[j]
      var scriptPubKeyASM = output.scriptPubKey.asm
      if (scriptPubKeyASM.split(' ')[0] === 'OP_RETURN') {
        var data = new Buffer(scriptPubKeyASM.split(' ')[1], 'hex')
        var length = dataPayload.parse(data)
        if (length) {
          primaryTransactions.push({tx: transaction, length: length, dataOutput: j, data: data})
        }
      }
    }
  }
  return primaryTransactions
}

var createTransactionWithPayload = function (payload, primaryTxHex) {
  var primaryTx = primaryTxHex ? bitcoin.TransactionBuilder.fromTransaction(bitcoin.Transaction.fromHex(primaryTxHex)) : false
  var lengthBuffer = new Buffer(1)
  lengthBuffer.writeUInt8(payload.length, 0)
  var payloadScript = bitcoin.Script.fromChunks([bitcoin.opcodes.OP_RETURN, payload])
  var tx = primaryTx || new bitcoin.TransactionBuilder()
  tx.addOutput(payloadScript, 0)
  return tx
}

var getData = function (options, callback) {
  var transactions = options.transactions
  var primaryTransactions = getPrimaryTransactions(transactions)
  var decodedTransactions = []
  async.each(primaryTransactions, function (primaryTx, cb) {
    var tx = primaryTx.tx
    var data = primaryTx.data
    var length = primaryTx.length
    var dataOutput = primaryTx.dataOutput
    var payloads = []
    for (var i = 0; i < length; i++) {
      if (i === 0) {
        payloads.push(data)
      } else {
        var prevTxid = tx.vin[dataOutput].txid
        transactions.forEach(function (txHex) {
          var _tx = txHexToJSON(txHex)
          if (prevTxid === _tx.txid) {
            tx = _tx
            var scriptPubKeyASM = tx.vout[dataOutput].scriptPubKey.asm
            var data = new Buffer(scriptPubKeyASM.split(' ')[1], 'hex')
            payloads.push(data)
          }
        })
      }
    }
    dataPayload.decode(payloads, function (err, decodedData) {
      if (err) { } // TODO
      var decodedTransaction = {
        data: decodedData
      }
      decodedTransactions.push(decodedTransaction)
      cb()
    })
  }, function (err) {
    if (err) { } // TODO
    callback(false, decodedTransactions)
  })
}

var signFromTransactionHex = function (signTransactionHex) {
  if (!signTransactionHex) {
    return false
  }
  return function (tx, input, callback) {
    var txHex = tx.tx.toHex()
    signTransactionHex({txHex: txHex, input: input}, function (error, signedTxHex) {
      var signedTx = bitcoin.TransactionBuilder.fromTransaction(bitcoin.Transaction.fromHex(signedTxHex))
      callback(error, signedTx)
    })
  }
}

var createSignedTransactionsWithData = function (options, callback) {
  var primaryTxHex = options.primaryTxHex
  var usedTxids = []
  var destinationAddress = options.destinationAddress
  var destinationValue = options.value || 0
  if (primaryTxHex) {
    var primaryTx = txHexToJSON(primaryTxHex)
    usedTxids = primaryTx.vin.map(function (input) { return input.txid })
  }
  var signPrimaryTxHex = options.signPrimaryTxHex
  var commonWallet = options.commonWallet
  var address = commonWallet.address
  var returnWithUnsignedPrimary = options.returnWithUnsignedPrimary
  var fee = options.fee || 1000
  var commonBlockchain = options.commonBlockchain
  var buildStatus = options.buildStatus || function () {}
  var signTransaction = signFromTransactionHex(commonWallet.signRawTransaction)
  options.signTransaction = signTransaction
  var data = options.data
  commonBlockchain.Addresses.Unspents([address], function (err, addresses_unspents) {
    if (err) { } // TODO
    var unspentOutputs = addresses_unspents[0]
    dataPayload.create({data: data}, function (err, payloads) {
      if (err) { } // TODO
      var signedTransactions = []
      var signedTransactionsCounter = payloads.length - 1
      var payloadsLength = payloads.length

      buildStatus({
        response: 'got payloads',
        data: data,
        payloadsLength: payloadsLength
      })

      var totalCost = payloadsLength * fee + destinationValue
      var existingUnspents = []
      var unspentValue = 0
      var compare = function (a, b) {
        if (a.value < b.value) {
          return -1
        }
        if (a.value > b.value) {
          return 1
        }
        return 0
      }
      unspentOutputs.sort(compare)
      for (var i = unspentOutputs.length - 1; i >= 0; i--) {
        var unspentOutput = unspentOutputs[i]
        if (usedTxids.indexOf(unspentOutput.txid) > -1) {
          continue
        }
        unspentValue += unspentOutput.value
        existingUnspents.push(unspentOutput)
        if (unspentValue >= totalCost) {
          break
        }
      }

      var signedTransactionResponse = function (err, signedTx) {
        if (err) { } // TODO

        if (signedTransactionsCounter === 0 && destinationAddress && destinationValue) {
          signedTx.addOutput(destinationAddress, destinationValue)
        }

        var signedTxBuilt = signedTx.buildIncomplete()
        var signedTxHex = signedTxBuilt.toHex()
        var signedTxid = signedTxBuilt.getId()

        var onSignedTxHexAndId = function (signedTxHex, signedTxid) {
          buildStatus({
            response: 'signed transaction',
            txid: signedTxid,
            count: signedTransactionsCounter,
            payloadsLength: payloadsLength
          })
          signedTransactions[signedTransactionsCounter] = signedTxHex
          signedTransactionsCounter--
          if (signedTransactionsCounter < 0) {
            callback(false, signedTransactions, signedTxid)
          } else {
            var vout = signedTx.tx.outs.length - 1

            var payload = payloads[signedTransactionsCounter]
            var tx
            if (signedTransactionsCounter === 0) {
              tx = createTransactionWithPayload(payload, primaryTxHex)
            } else {
              tx = createTransactionWithPayload(payload)
            }

            var value = signedTx.tx.outs[vout].value

            var unspent = {
              txid: signedTxid,
              vout: vout,
              value: value
            }

            var skipSign = returnWithUnsignedPrimary && signedTransactionsCounter === 0

            loadAndSignTransaction({
              fee: fee,
              tx: tx,
              unspentOutputs: [unspent],
              address: address,
              skipSign: skipSign,
              signTransaction: options.signTransaction,
              destinationValue: (signedTransactionsCounter === 0) ? destinationValue : false
            }, signedTransactionResponse)
          }
        }

        if (signPrimaryTxHex && signedTransactionsCounter === 0) {
          signPrimaryTxHex(signedTxHex, function (err, signedTxHex) {
            if (err) { } // TODO
            var _tx = bitcoin.TransactionBuilder.fromTransaction(bitcoin.Transaction.fromHex(signedTxHex))
            onSignedTxHexAndId(signedTxHex, _tx.build().getId())
          })
        } else {
          onSignedTxHexAndId(signedTxHex, signedTxid)
        }
      }

      var tx
      if (signedTransactionsCounter === 0) {
        tx = createTransactionWithPayload(payloads[signedTransactionsCounter], primaryTxHex)
      } else {
        tx = createTransactionWithPayload(payloads[signedTransactionsCounter])
      }

      var signOptions = {
        fee: fee,
        tx: tx,
        unspentOutputs: existingUnspents,
        address: address,
        signTransaction: options.signTransaction,
        signPrimaryTxHex: signPrimaryTxHex,
        destinationValue: (signedTransactionsCounter === 0) ? destinationValue : false
      }

      loadAndSignTransaction(signOptions, signedTransactionResponse)
    })
  })
}

module.exports = {
  createSignedTransactionsWithData: createSignedTransactionsWithData,
  getData: getData
}
