const BaseController = require('./BaseController')
const { AccountBalance } = require('../protos')
const { store, queue, util, response } = require('../utils')
const { AccountsService, TransactionsService, GeneralsService } = require('../services')

module.exports = class Accounts extends BaseController {
  constructor() {
    super(new AccountsService())
    this.generalsService = new GeneralsService()
    this.transactionsService = new TransactionsService()
  }

  static getFirstActiveAccount(service, accountAddress) {
    return new Promise(resolve => {
      service.getFirstActiveByAccountAddress(accountAddress, (err, res) => {
        if (err) return resolve(null)
        return resolve(res ? res.FirstActive : null)
      })
    })
  }

  static getTotalFeeAccount(service, accountAddress) {
    return new Promise(resolve => {
      service.getTotalFeeByAccountAddress(accountAddress, (err, res) => {
        if (err) return resolve(null)
        return resolve(res ? res.TotalFeesPaid : 0)
      })
    })
  }

  static asyncSendersByHeights(service, heightStart, heightEnd) {
    return new Promise(resolve => {
      service.getSendersByHeights(heightStart, heightEnd, (err, res) => {
        if (err) return resolve({ error: err, data: [] })
        if (!res) return resolve({ error: null, data: [] })
        return resolve({ error: null, data: res })
      })
    })
  }

  static asyncRecipientsByHeights(service, heightStart, heightEnd) {
    return new Promise(resolve => {
      service.getRecipientsByHeights(heightStart, heightEnd, (err, res) => {
        if (err) return resolve({ error: err, data: [] })
        if (!res) return resolve({ error: null, data: [] })
        return resolve({ error: null, data: res })
      })
    })
  }

  static synchronize(service, payloads) {
    /** send message telegram bot if avaiable */
    if (!payloads) return response.sendBotMessage('Accounts', '[Accounts] Synchronize - Invalid payloads')
    if (payloads && !payloads.params)
      return response.sendBotMessage(
        'Accounts',
        '[Accounts] Synchronize - Invalid params',
        `- Payloads : <pre>${JSON.stringify(payloads)}</pre>`
      )
    if (payloads && !payloads.accounts)
      return response.sendBotMessage(
        'Accounts',
        '[Accounts] Synchronize - Invalid account transactions',
        `- Payloads : <pre>${JSON.stringify(payloads)}</pre>`
      )

    /** separated variables payloads */
    const { params, accounts } = payloads

    return new Promise(resolve => {
      AccountBalance.GetAccountBalance(params, (err, res) => {
        if (err)
          return resolve(
            /** send message telegram bot if avaiable */
            response.sendBotMessage(
              'Accounts',
              `[Accounts] Proto Get Account Balance - ${err}`,
              `- Params : <pre>${JSON.stringify(params)}</pre>`
            )
          )
        if (res && util.isObjEmpty(res.AccountBalance)) return resolve(null)
        if (res && util.isObjEmpty(res.AccountBalance)) return resolve(response.setResult(false, `[Accounts] No additional data`))

        const datas = [
          {
            AccountAddress: res.AccountBalance.AccountAddress,
            Balance: parseInt(res.AccountBalance.Balance),
            BalanceConversion: util.zoobitConversion(res.AccountBalance.Balance),
            SpendableBalance: parseInt(res.AccountBalance.SpendableBalance),
            SpendableBalanceConversion: util.zoobitConversion(res.AccountBalance.SpendableBalance),
            FirstActive: accounts.FirstActive,
            LastActive: accounts.Timestamp,
            TotalRewards: null, // TODO: onprogress
            TotalRewardsConversion: null, // TODO: onprogress
            TotalFeesPaid: parseInt(accounts.TotalFee),
            TotalFeesPaidConversion: util.zoobitConversion(accounts.TotalFee),
            BlockHeight: res.AccountBalance.BlockHeight,
            TransactionHeight: accounts.Height,
            PopRevenue: parseInt(res.AccountBalance.PopRevenue),
          },
        ]
        service.upserts(datas, ['AccountAddress'], (err, res) => {
          /** send message telegram bot if avaiable */
          if (err) return resolve(response.sendBotMessage('Accounts', `[Accounts] Upsert - ${err}`))
          if (res && res.result.ok !== 1) return resolve(response.setError(`[Accounts] Upsert data failed`))
          return resolve(response.setResult(true, `[Accounts] Upsert ${datas.length} data successfully`))
        })
      })
    })
  }

  update(callback) {
    /** get last height account (local) */
    this.service.getLastHeight(async (err, res) => {
      /** send message telegram bot if avaiable */
      if (err) return callback(response.sendBotMessage('Accounts', `[Accounts] Accounts Service - Get Last Height ${err}`))

      /** set variable last height account */
      const lastAccountHeight = res ? parseInt(res.TransactionHeight + 1) : 0

      /** getting value last check height transaction */
      const lastCheckTransactionHeight = parseInt(await this.generalsService.getValueByKey(store.keyLastCheckTransactionHeight)) || 0

      /** return message if last height account greather than last check height transaction  */
      if (lastAccountHeight > 0 && lastAccountHeight >= lastCheckTransactionHeight)
        return callback(response.setResult(false, '[Accounts] No additional data'))

      /** getting data account sender transactions */
      const senders = await Accounts.asyncSendersByHeights(this.transactionsService, lastAccountHeight, lastCheckTransactionHeight)
      if (senders.error) return callback(response.sendBotMessage('Accounts', `[Accounts] Transactions Service - Get Senders ${err}`))

      /** getting data account recipient transactions */
      const recipients = await Accounts.asyncRecipientsByHeights(this.transactionsService, lastAccountHeight, lastCheckTransactionHeight)
      if (recipients.error) return callback(response.sendBotMessage('Accounts', `[Accounts] Transactions Service - Get Recipients ${err}`))

      /** return message if havingn't senders or receipts  */
      if (senders.data.length < 1 && recipients.data.length < 1) return callback(response.setResult(false, '[Accounts] No additional data'))

      /** initiating the queue */
      queue.init('Queue Accounts')

      /** adding multi jobs to the queue by account sender transactions */
      senders.data.forEach(async item => {
        /** set first active base on data account (local), if data empty so that set by timestamp */
        const firstActive = await Accounts.getFirstActiveAccount(this.service, item.Sender)

        /** set total fee base on data account (local) for calculate total fee paid */
        const totalFee = await Accounts.getTotalFeeAccount(this.service, item.Sender)

        const payloads = {
          params: { AccountAddress: item.Sender },
          accounts: {
            AccountAddress: item.Sender,
            Height: item.Height,
            TotalFee: parseInt(totalFee) + parseInt(item.Fee),
            Timestamp: item.Timestamp,
            FirstActive: firstActive ? firstActive : item.Timestamp,
            SendMoney: item.SendMoney || null,
          },
        }
        queue.addJob(payloads)
      })

      /** adding multi jobs to the queue by account receipt transactions */
      recipients.data.forEach(async item => {
        /** set first active base on data account (local), if data empty so that set by timestamp */
        const firstActive = await Accounts.getFirstActiveAccount(this.service, item.Recipient)

        /** set total fee base on data account (local), its not for calculating. just for update using data before */
        const totalFee = await Accounts.getTotalFeeAccount(this.service, item.Recipient)

        const payloads = {
          params: { AccountAddress: item.Recipient },
          accounts: {
            AccountAddress: item.Recipient,
            Height: item.Height,
            TotalFee: totalFee,
            Timestamp: item.Timestamp,
            FirstActive: firstActive ? firstActive : item.Timestamp,
            SendMoney: null,
          },
        }
        queue.addJob(payloads)
      })

      /** processing job the queue */
      queue.processJob(Accounts.synchronize, this.service)

      const count = parseInt(senders.data.length) + parseInt(recipients.data.length)
      return callback(response.setResult(true, `[Queue] ${count} Accounts on processing`))
    })
  }
}
