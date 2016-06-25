const rx = require('rx');
const needle = require('needle');
const debug = require('debug')('bankapi');

const baseUrl = 'https://apisandbox.openbankproject.com'
const baseApiUrl = `${baseUrl}/obp/v2.0.0`
const consumerKey = 'aotg5jrxdsmfiszgod1fa2olzjxmwo1mtjiuj140'

const api = {
  authenticate: (username, password) => {
    const authSubject = new rx.AsyncSubject();
    username = 'borysp@backbase.com'
    password = 'Password_01'
    const options = {
      headers: {
        'content-type': 'application/json',
        'authorization': `DirectLogin username="${username}", password="${password}", consumer_key="${consumerKey}"`
      }
    }

    needle.post(`${baseUrl}/my/logins/direct`, {}, options, (err, res, body) => {
      if (err || body.error) {
        authSubject.onError(err || body.error);
      } else {
        authSubject.onNext(body.token);
      }
      authSubject.onCompleted();
    });

    return authSubject;
  },

  getAccounts: token => {
    const authSubject = new rx.AsyncSubject();
    const options = {
      headers: {
        'content-type': 'application/json',
        'authorization': `DirectLogin token="${token}"`
      }
    }

    needle.get(`${baseApiUrl}/accounts`, options, (err, res, body) => {
      if (err || body.error) {
        authSubject.onError(err || body.error);
      } else {
        const accounts = body.map(account => ({
            id: account.id,
            name: account.label || account.id,
            bankId: account.bank_id
        }));

        authSubject.onNext(accounts);
      }
      authSubject.onCompleted();
    })
    return authSubject;
  },

  getBanks: token => {
    const authSubject = new rx.AsyncSubject();
    const options = {
      headers: {
        'content-type': 'application/json',
        'authorization': `DirectLogin token="${token}"`
      }
    }

    needle.get(`${baseApiUrl}/banks`, options, (err, res, body) => {
      if (err || body.error) {
        authSubject.onError(err || body.error);
      } else {
        const banks = body.banks.map(bank => ({
            id: bank.id,
            name: bank.full_name
        }));

        authSubject.onNext(banks);
      }
      authSubject.onCompleted();
    })
    return authSubject;
  },

  getBankAccounts: (token, bankId) => {
    const authSubject = new rx.AsyncSubject();
    const options = {
      headers: {
        'content-type': 'application/json',
        'authorization': `DirectLogin token="${token}"`
      }
    }

    needle.get(`${baseApiUrl}/banks/${bankId}/accounts`, options, (err, res, body) => {
      if (err || body.error) {
        authSubject.onError(err || body.error);
      } else {
        const accounts = body.map(account => ({
            id: account.id,
            name: account.label || account.id
        }));

        authSubject.onNext(accounts);
      }
      authSubject.onCompleted();
    })
    return authSubject;
  }
}

export default api
