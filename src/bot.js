const rx = require('rx');
const _ = require('underscore-plus');

const Slack = require('slack-client');
const SlackApiRx = require('./slack-api-rx');
const TexasHoldem = require('./texas-holdem');
const MessageHelpers = require('./message-helpers');
const PlayerInteraction = require('./player-interaction');
const config = require('./config');

const WeakBot = require('../ai/weak-bot');
const AggroBot = require('../ai/aggro-bot');

const debug = require('debug')('game');

class Bot {
  // Public: Creates a new instance of the bot.
  //
  // token - An API token from the bot integration
  constructor(token) {
    this.slack = new Slack(token, true, true);
    this.currency = '$';

    this.gameConfig = {};
    this.gameConfigParams = ['timeout'];
  }

  // Public: Brings this bot online and starts handling messages sent to it.
  login() {
    rx.Observable.fromEvent(this.slack, 'open')
      .subscribe(() => this.onClientOpened());

    this.slack.login();
    this.respondToMessages();
  }

  // Private: Listens for messages directed at this bot that contain the word
  // 'deal,' and poll players in response.
  //
  // Returns a {Disposable} that will end this subscription
  respondToMessages() {
    let messages = rx.Observable.fromEvent(this.slack, 'message')
      .where(e => e.type === 'message');

    let atMentions = messages.where(e =>
      MessageHelpers.containsUserMention(e.text, this.slack.self.id));

    let disp = new rx.CompositeDisposable();

    disp.add(this.handleDealGameMessages(messages, atMentions));
    disp.add(this.handleConfigMessages(atMentions));

    return disp;
  }

  // Private: Looks for messages directed at the bot that contain the word
  // "deal." When found, start polling players for a game.
  //
  // messages - An {Observable} representing messages posted to a channel
  // atMentions - An {Observable} representing messages directed at the bot
  //
  // Returns a {Disposable} that will end this subscription
  handleDealGameMessages(messages, atMentions) {
    return atMentions
      .where(e => e.text && e.text.toLowerCase().match(/\bdeal\b/))
      .map(e => this.slack.getChannelGroupOrDMByID(e.channel))
      .where(channel => {
        if (this.isPolling) {
          return false;
        } else if (this.isGameRunning) {
          channel.send('Another game is in progress, quit that first.');
          return false;
        }
        debug('new deal game mention is found');
        return true;
      })
      .where(channel => {
          channel.send('Please, set currency for the game ("EUR", "GBP", "USD"):');
          messages
            .where(e => e.text && e.text.match(/^(usd|eur|gbp|\$|€|£)$/i))
            .take(1)
            .map(e => {
              this.setCurrency(e.text);
              channel.send('Currency is set to: ' + this.currencyCode);
              this.pollPlayersForGame(messages, channel).subscribe();
            })
            .publish()
            .connect();
        return true;
      })
      .subscribe();
  }

  setCurrency(currency) {
    switch(currency.toLowerCase()){
      case 'usd' :
        this.currency = '$';
        this.currencyCode = 'USD';
        break;
      case 'eur' :
        this.currency = '€';
        this.currencyCode = 'EUR';
        break;
      case 'gbp' :
        this.currency = '£';
        this.currencyCode = 'GBP';
        break;
      default :
        this.currency = '$';
        this.currencyCode = 'USD';
    }
  }

  // Private: Looks for messages directed at the bot that contain the word
  // "config" and have valid parameters. When found, set the parameter.
  //
  // atMentions - An {Observable} representing messages directed at the bot
  //
  // Returns a {Disposable} that will end this subscription
  handleConfigMessages(atMentions) {
    return atMentions
      .where(e => e.text && e.text.toLowerCase().includes('config'))
      .subscribe(e => {
        let channel = this.slack.getChannelGroupOrDMByID(e.channel);

        e.text.replace(/(\w*)=(\d*)/g, (match, key, value) => {
          if (this.gameConfigParams.indexOf(key) > -1 && value) {
            this.gameConfig[key] = value;
            channel.send(`Game ${key} has been set to ${value}.`);
          }
        });
      });
  }

  // Private: Polls players to join the game, and if we have enough, starts an
  // instance.
  //
  // messages - An {Observable} representing messages posted to the channel
  // channel - The channel where the deal message was posted
  //
  // Returns an {Observable} that signals completion of the game
  pollPlayersForGame(messages, channel) {
    this.isPolling = true;

    debug('poll players for a game');
    return PlayerInteraction.pollPotentialPlayers(messages, channel)
      .map(playerId => this.slack.getUserByID(playerId))
      .flatMap(player => this.connectPlayersToOpenBank(messages, channel, player))
      .reduce((players, user) => {
        debug(`${user.name} has joined the game.`);
        channel.send(`${user.name} has joined the game.`);

        players.push(_.pick(user, ['id', 'name', 'chips', 'bankId', 'accountId', 'authToken']));
        return players;
      }, [])
      .flatMap(players => {
        this.isPolling = false;
        this.addBotPlayers(players);

        let messagesInChannel = messages.where(e => e.channel === channel.id);
        return this.startGame(messagesInChannel, channel, players);
      });
  }

  connectPlayersToOpenBank(messages, channel, user) {
    let messagesInChannel
    let directChannel

    return SlackApiRx.getOrOpenDm(this.slack, user)
      .pluck('dm')
      .flatMap(dm => {
        directChannel = dm
        messagesInChannel = messages.where(e => e.channel === dm.id);

        return PlayerInteraction.connectToOpenBank(messagesInChannel, directChannel, user)
          .flatMap(token => {
            user.authToken = token;
            return rx.Observable.return(user)
          });
      })
      .flatMap(user => {
        if(user) {
          return PlayerInteraction.selectBank(messagesInChannel, directChannel, user);
        } else {
          return rx.Observable.empty();
        }
      })
/*      .flatMap(user => {
        if(user) {
          return PlayerInteraction.selectAccount(messagesInChannel, directChannel, user);
        } else {
          return rx.Observable.empty();
        }
      })*/
      .flatMap(user => {
        if(user) {
          return PlayerInteraction.selectAccountAndLimit(messagesInChannel, directChannel, user, this.currency, this.currencyCode)
        } else {
          return rx.Observable.empty();
        }
      })
      .flatMap(() => rx.Observable.return(user));
  }

  // Private: Starts and manages a new Texas Hold'em game.
  //
  // messages - An {Observable} representing messages posted to the channel
  // channel - The channel where the game will be played
  // players - The players participating in the game
  //
  // Returns an {Observable} that signals completion of the game
  startGame(messages, channel, players) {
    if (players.length <= 1) {
      channel.send('Not enough players for a game, try again later.');
      return rx.Observable.return(null);
    }

    debug(`We've got ${players.length} players, let's start the game.`);
    channel.send(`We've got ${players.length} players, let's start the game.`);
    this.isGameRunning = true;

    let game = new TexasHoldem(this.slack, messages, channel, players, this.currency, this.currencyCode);
    _.extend(game, this.gameConfig);

    // Listen for messages directed at the bot containing 'quit game.'
    let quitGameDisp = messages.where(e => MessageHelpers.containsUserMention(e.text, this.slack.self.id) &&
      e.text.toLowerCase().match(/quit game/))
      .take(1)
      .subscribe(e => {
        // TODO: Should poll players to make sure they all want to quit.
        let player = this.slack.getUserByID(e.user);
        channel.send(`${player.name} has decided to quit the game. The game will end after this hand.`);
        game.quit();
      });

    return SlackApiRx.openDms(this.slack, players)
      .flatMap(playerDms => rx.Observable.timer(2000)
        .flatMap(() => game.start(playerDms)))
      .do(() => {
        quitGameDisp.dispose();
        this.isGameRunning = false;
      });
  }

  // Private: Adds AI-based players (primarily for testing purposes).
  //
  // players - The players participating in the game
  addBotPlayers(players) {
    if (config.botNumber > 0) {
      players.push(new WeakBot('Phil Hellmuth'));
    }
    if (config.botNumber > 1) {
      players.push(new AggroBot('Phil Ivey'));
    }
  }

  // Private: Save which channels and groups this bot is in and log them.
  onClientOpened() {
    this.channels = _.keys(this.slack.channels)
      .map(k => this.slack.channels[k])
      .filter(c => c.is_member);

    this.groups = _.keys(this.slack.groups)
      .map(k => this.slack.groups[k])
      .filter(g => g.is_open && !g.is_archived);

    this.dms = _.keys(this.slack.dms)
      .map(k => this.slack.dms[k])
      .filter(dm => dm.is_open);

    console.log(`Welcome to Slack. You are ${this.slack.self.name} of ${this.slack.team.name}`);

    if (this.channels.length > 0) {
      console.log(`You are in: ${this.channels.map(c => c.name).join(', ')}`);
    } else {
      console.log('You are not in any channels.');
    }

    if (this.groups.length > 0) {
      console.log(`As well as: ${this.groups.map(g => g.name).join(', ')}`);
    }

    if (this.dms.length > 0) {
      console.log(`Your open DM's: ${this.dms.map(dm => dm.name).join(', ')}`);
    }
  }
}

module.exports = Bot;
