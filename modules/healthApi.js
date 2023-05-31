const express = require('express');
const config = require('./configReader');
const log = require('../helpers/log');

module.exports = {
  startServer: () => {
    const port = config.health_api;

    if (port && typeof port === 'number') {
      const app = express();

      app.get('/ping', (req, res) => {
        res.status(200).send({ timestamp: Date.now() });
      });

      app.listen(port, () => {
        log.log(`Health HTTP server started at port: ${port}`);
      });
    }
  },
};
