module.exports = {
  passPhrase: {
    type: String,
    isRequired: true,
  },
  node_ADM: {
    type: [String],
    isRequired: true,
  },
  infoservice: {
    type: [String],
    default: ['https://info.adamant.im'],
  },
  exchanges: {
    type: [String],
    isRequired: true,
  },
  exchange: {
    type: String,
    isRequired: true,
  },
  pair: {
    type: String,
    isRequired: true,
  },
  apikey: {
    type: String,
    isRequired: true,
  },
  apisecret: {
    type: String,
    isRequired: true,
  },
  apipassword: {
    type: String,
    default: '',
  },
  admin_accounts: {
    type: [String],
    default: [],
  },
  notify_non_admins: {
    type: Boolean,
    default: false,
  },
  socket: {
    type: Boolean,
    default: true,
  },
  ws_type: {
    type: String,
    isRequired: true,
  },
  bot_name: {
    type: String,
    isRequired: true,
  },
  adamant_notify: {
    type: [String],
    default: [],
  },
  adamant_notify_priority: {
    type: [String],
    default: [],
  },
  slack: {
    type: [String],
    default: [],
  },
  slack_priority: {
    type: [String],
    default: [],
  },
  silent_mode: {
    type: Boolean,
    default: false,
  },
  log_level: {
    type: String,
    default: 'log',
  },
  welcome_string: {
    type: String,
    default: 'Hello 😊. This is a stub. I have nothing to say. Please check my config.',
  },
  api: {
    type: {
      port: {
        type: Number,
        isRequired: true,
      },
      health: {
        type: Boolean,
        default: true,
      },
      debug: {
        type: Boolean,
        default: true,
      },
    },
  },
  amount_to_confirm_usd: {
    type: Number,
    default: 100,
  },
};
