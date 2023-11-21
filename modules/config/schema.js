module.exports = {
  cli: {
    type: Boolean,
    default: false,
  },
  secret_key: {
    type: String,
    default: '',
    isRequired: false,
  },
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
  fund_supplier: {
    type: Object,
    default: {
      enabled: false,
      coins: [],
    },
  },
  clearAllOrdersInterval: {
    type: Number,
    default: 0,
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
    default: 'ws',
  },
  bot_name: {
    type: String,
    default: '',
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
  telegram: {
    type: [String],
    default: [],
  },
  telegram_priority: {
    type: [String],
    default: [],
  },
  email_notify: {
    type: [String],
    default: [],
  },
  email_priority: {
    type: [String],
    default: [],
  },
  email_notify_aggregate_min: {
    type: Number,
    default: false,
  },
  email_smtp: {
    type: Object,
    default: {},
  },
  silent_mode: {
    type: Boolean,
    default: false,
  },
  log_level: {
    type: String,
    default: 'log',
  },
  webui_accounts: {
    type: [Object],
    default: [],
  },
  webui: {
    type: Number,
  },
  welcome_string: {
    type: String,
    default: 'Hello 😊. This is a stub. I have nothing to say. Please check my config.',
  },
  api: {
    type: Object,
    default: {},
  },
  com_server: {
    type: String,
    default: false,
  },
  com_server_secret_key: {
    type: String,
  },
  amount_to_confirm_usd: {
    type: Number,
    default: 100,
  },
  exchange_socket: {
    type: Boolean,
    default: false,
  },
  exchange_socket_pull: {
    type: Boolean,
    default: false,
  },
};
