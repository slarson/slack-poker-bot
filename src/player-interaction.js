const rx = require('rx');
const _ = require('underscore-plus');
const OBAPI = require('./open-bank-api');

const config = require('./config');

const debug = require('debug')('game');

class PlayerInteraction {
  // Public: Poll players that want to join the game during a specified period
  // of time.
  //
  // messages - An {Observable} representing new messages sent to the channel
  // channel - The {Channel} object, used for posting messages
  // scheduler - (Optional) The scheduler to use for timing events
  // timeout - (Optional) The amount of time to conduct polling, in seconds
  // maxPlayers - (Optional) The maximum number of players to allow
  //
  // Returns an {Observable} that will `onNext` for each player that joins and
  // `onCompleted` when time expires or the max number of players join.
  static pollPotentialPlayers(messages, channel, scheduler=rx.Scheduler.timeout, timeout=config.pollTimeout, maxPlayers=10) {
    debug('poll potential players for a game, channel is %s', channel.name);
    let formatMessage = t => `Who wants to play? Respond with 'yes' in this channel in the next ${t} seconds.`;
    let timeExpired = PlayerInteraction.postMessageWithTimeout(channel, formatMessage, scheduler, timeout);

    // Look for messages containing the word 'yes' and map them to a unique
    // user ID, constrained to `maxPlayers` number of players.
    let newPlayers = messages.where(e => e.text && e.text.toLowerCase().match(/\byes\b/))
      .map(e => e.user)
      .distinct()
      .take(maxPlayers)
      .publish();

    newPlayers.connect();
    timeExpired.connect();

    // Once our timer has expired, we're done accepting new players.
    return newPlayers.takeUntil(timeExpired);
  }

  static connectToOpenBank(messages, channel, user) {
    channel.send('Connect to your OpenBank account');

    return this.getUserInput(messages, channel, 'Username')
      .flatMap(username => {
        return this.getUserInput(messages, channel, 'Password')
          .flatMap(password => {
            return this.openOpenBankConnection(username, password);
          });
      });
  }

  static selectAccountAndLimit(messages, channel, user, currency, currencyCode) {
    return this.selectAccount(messages, channel, user)
      .flatMap(user => {
        if(user) {
          return PlayerInteraction.setExpenseLimit(messages, channel, user, currency, currencyCode)
        } else {
          return rx.Observable.empty();
        }
      });
  }

  static setExpenseLimit(messages, channel, user, currency, currencyCode, availableAmount=400) {
    return OBAPI.getBankAccount(user.authToken, user.bankId, user.accountId, user.accountViews[0].id)
      .flatMap(account => {
        if(account.balance.currency !== currencyCode) {
          channel.send(`Account currency is "${account.balance.currency}", but it should be "${currencyCode}". Please, select different account.`);
          return this.selectAccountAndLimit(messages, channel, user, currency, currencyCode);
        }

        if(parseFloat(account.balance.amount) < config.minExpense) {
          channel.send(`Sorry, ${currency}${account.balance.amount} is not enough to play this game (minimum required amount is ${currency}${config.minExpense}). Please select different account.`);
          return this.selectAccountAndLimit(messages, channel, user, currency, currencyCode);
        }

        channel.send(`Available amount for this account is ${currency}${account.balance.amount}.`);
        return this.getUserInput(messages, channel, `Please, specify your game bankroll (not less than ${currency}${config.minExpense})`)
      })
      .flatMap(amount => {
        amount = parseFloat(amount)
        if (amount < config.minExpense) {
          channel.send('I warned you! Bye bye.');
          return rx.Observable.empty();
        }
        debug('expense limit for %s is set to %s%s', user.name, currency, amount);
        user.chips = amount;
        return rx.Observable.return(user);
      });
  }

  static getUserInput(messages, channel, property) {
    channel.send(`${property}:`)

    return messages
      .take(1)
      .flatMap(message => {
        const text = message.text.replace(/^<(?:mailto\:)?([^\|]+)(?:\|.+)?>$/, (str, p) => p);
        return rx.Observable.return(text)
      });
  }

  static openOpenBankConnection(username, password) {
    return OBAPI.authenticate(username, password);
  }

  static selectBank(messages, channel, user) {
    channel.send('Please select Bank from available list (enter Bank number):')

    return rx.Observable.forkJoin(
      OBAPI.getBanks(user.authToken),
      OBAPI.getAccounts(user.authToken)
    )
      .flatMap(result => {
        let banks = result[0].filter(bank => result[1].some(account => (account.bankId === bank.id)))
        channel.send(banks.map((bank, i) => `${i+1}. ${bank.name}`).join('\n'))

        return messages
          .where(e => {
            let val
            return e.text && (val = parseInt(e.text)) && !isNaN(val) && (val >= 1) && (val <= banks.length);
          })
          .take(1)
          .flatMap(message => {
            const bank = banks[parseInt(message.text) - 1];
            user.bankId = bank.id;
            console.log(`Bank ID: ${bank.id}`)
            return rx.Observable.return(user);
          });
      });
  }

  static selectAccount(messages, channel, user) {
    channel.send('Please select Account from available list (enter Acount number):')

    return OBAPI.getBankAccounts(user.authToken, user.bankId)
      .flatMap(accounts => {
        channel.send(accounts.map((account, i) => `${i+1}. ${account.name}`).join('\n'))

        return messages
          .where(e => {
            let val
            return e.text && (val = parseInt(e.text)) && !isNaN(val) && (val >= 1) && (val <= accounts.length);
          })
          .take(1)
          .flatMap(message => {
            const account = accounts[parseInt(message.text) - 1];
            user.accountId = account.id;
            user.accountViews = account.views;
            console.log(`Account ID: ${account.id}`)
            return rx.Observable.return(user);
          });
      });
  }

  // Public: Poll a specific player to take a poker action, within a timeout.
  //
  // messages - An {Observable} representing new messages sent to the channel
  // channel - The {Channel} object, used for posting messages
  // player - The player being polled
  // previousActions - A map of players to their most recent action
  // scheduler - (Optional) The scheduler to use for timing events
  // timeout - (Optional) The amount of time to conduct polling, in seconds
  //
  // Returns an {Observable} indicating the action the player took. If time
  // expires, a 'timeout' action is returned.
  static getActionForPlayer(messages, channel, player, previousActions,
    scheduler=rx.Scheduler.timeout, timeout=30) {
    let availableActions = PlayerInteraction.getAvailableActions(player, previousActions);
    let formatMessage = t => PlayerInteraction.buildActionMessage(player, availableActions, t);

    let timeExpired = null;
    let expiredDisp = null;
    if (timeout > 0) {
      timeExpired = PlayerInteraction.postMessageWithTimeout(channel, formatMessage, scheduler, timeout);
      expiredDisp = timeExpired.connect();
    } else {
      channel.send(formatMessage(0));
      timeExpired = rx.Observable.never();
      expiredDisp = rx.Disposable.empty;
    }

    // Look for text that conforms to a player action.
    let playerAction = messages.where(e => e.user === player.id)
      .map(e => PlayerInteraction.actionFromMessage(e.text, availableActions))
      .where(action => action !== null)
      .publish();

    playerAction.connect();

    // If the user times out, they will be auto-folded unless they can check.
    let actionForTimeout = timeExpired.map(() =>
      availableActions.indexOf('check') > -1 ?
        { name: 'check' } :
        { name: 'fold' });

    let botAction = player.isBot ?
      player.getAction(availableActions, previousActions) :
      rx.Observable.never();

    // NB: Take the first result from the player action, the timeout, and a bot
    // action (only applicable to bots).
    return rx.Observable.merge(playerAction, actionForTimeout, botAction)
      .take(1)
      .do(() => expiredDisp.dispose());
  }

  // Private: Posts a message to the channel with some timeout, that edits
  // itself each second to provide a countdown.
  //
  // channel - The channel to post in
  // formatMessage - A function that will be invoked once per second with the
  //                 remaining time, and returns the formatted message content
  // scheduler - The scheduler to use for timing events
  // timeout - The duration of the message, in seconds
  //
  // Returns an {Observable} sequence that signals expiration of the message
  static postMessageWithTimeout(channel, formatMessage, scheduler, timeout) {
    let timeoutMessage = channel.send(formatMessage(timeout));

    let timeExpired = rx.Observable.timer(0, 1000, scheduler)
      .take(timeout + 1)
      .do((x) => timeoutMessage.updateMessage(formatMessage(`${timeout - x}`)))
      .publishLast();

    return timeExpired;
  }

  // Private: Builds up a formatted countdown message containing the available
  // actions.
  //
  // player - The player who is acting
  // availableActions - An array of the actions available to this player
  // timeRemaining - Number of seconds remaining for the player to act
  //
  // Returns the formatted string
  static buildActionMessage(player, availableActions, timeRemaining) {
    let message = `${player.name}, it's your turn. Respond with:\n`;
    for (let action of availableActions) {
      message += `*(${action.charAt(0).toUpperCase()})${action.slice(1)}*\t`;
    }

    if (timeRemaining > 0) {
      message += `\nin the next ${timeRemaining} seconds.`;
    }

    return message;
  }

  // Private: Given an array of actions taken previously in the hand, returns
  // an array of available actions.
  //
  // player - The player who is acting
  // previousActions - A map of players to their most recent action
  //
  // Returns an array of strings
  static getAvailableActions(player, previousActions) {
    let actions = _.values(previousActions);
    let betActions = _.filter(actions, a => a.name === 'bet' || a.name === 'raise');
    let hasBet = betActions.length > 0;

    let availableActions = [];

    if (player.hasOption) {
      availableActions.push('check');
      availableActions.push('raise');
    } else if (hasBet) {
      availableActions.push('call');
      availableActions.push('raise');
    } else {
      availableActions.push('check');
      availableActions.push('bet');
    }

    // Prevent players from raising when they don't have enough chips.
    let raiseIndex = availableActions.indexOf('raise');
    if (raiseIndex > -1) {
      let previousWager = player.lastAction ? player.lastAction.amount : 0;
      let availableChips = player.chips + previousWager;

      if (_.max(betActions, a => a.amount).amount >= availableChips) {
        availableActions.splice(raiseIndex, 1);
      }
    }

    availableActions.push('fold');
    return availableActions;
  }

  // Private: Parse player input into a valid action.
  //
  // text - The text that the player entered
  // availableActions - An array of the actions available to this player
  //
  // Returns an object representing the action, with keys for the name and
  // bet amount, or null if the input was invalid.
  static actionFromMessage(text, availableActions) {
    if (!text) return null;

    let input = text.trim().toLowerCase().split(/\s+/);
    if (!input[0]) return null;

    let name = '';
    let amount = 0;

    switch (input[0]) {
    case 'c':
      name = availableActions[0];
      break;
    case 'call':
      name = 'call';
      break;
    case 'check':
      name = 'check';
      break;
    case 'f':
    case 'fold':
      name = 'fold';
      break;
    case 'b':
    case 'bet':
      name = 'bet';
      amount = input[1] ? parseInt(input[1]) : NaN;
      break;
    case 'r':
    case 'raise':
      name = 'raise';
      amount = input[1] ? parseInt(input[1]) : NaN;
      break;
    default:
      return null;
    }

    // NB: Unavailable actions are always invalid.
    return availableActions.indexOf(name) > -1 ?
      { name: name, amount: amount } :
      null;
  }
}

module.exports = PlayerInteraction;
