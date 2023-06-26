const config = require('./config/reader');
module.exports = require('./trade/' + config.exchange)(config.apikey, config.apisecret, config.apipassword);
