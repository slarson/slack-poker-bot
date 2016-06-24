const config = {
    botNumber: 0,
    pollTimeout: 30,
    smallBlind: 1
}

config.bigBlind = config.smallBlind * 2
config.minExpense = config.bigBlind * 100

export default config
