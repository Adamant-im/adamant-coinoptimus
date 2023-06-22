const config = require('./config/reader');
const log = require('../helpers/log');
module.exports = require('adamant-api')({ node: config.node_ADM, logLevel: config.log_level }, log);
