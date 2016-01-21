var ds18x20 = require('ds18x20')
var express = require("express")
var gpio = require("gpio");
var http = require("http")
var Primus = require("primus")

// Variables
var port = process.env.PORT || 3000
var power_ctrl_pin = process.env.PWR_CTRL_PIN || 17
var temp_poll_interval = process.env.POLL_INTERVAL || 1000
var last_temp
var power_state = 0


// Setup app
var app = express()
app.use('/', express.static(__dirname + '/public'))


// Set up webserver
var server = http.createServer(app)
server.listen(port)


// Setup socket
var primus = Primus(server, { transformer: "engine.io" })
primus.use('emit', require('primus-emit'));
primus.on('connection', function(spark) {
  console.log('client ' + spark.id + ' has connected to the server')

  // Send initial state
  spark.emit('power', power_ctrl._get())
  spark.emit('temp', last_temp, new Date(), power_state)

  // Handle manual power override signal
  spark.on('power', function custom(val) {
    power_ctrl.set(parseInt(val))
    console.log(val)
  });
})

primus.on('disconnection', function(spark) {
  console.log('client ' + spark.id + ' has disconnected to the server')
})


// Setup temperature sensor
function getTemp(sensor_id) {
  ds18x20.get(sensor_id, function (err, temp) {
    last_temp = temp

    // Send data to each cnxn
    primus.forEach(function (spark) {
      spark.emit('temp', temp, new Date(), power_state);
    })
  })
}
// Schedule temperature sensor poll
ds18x20.list(function (err, listOfDeviceIds) {
    var sensor_id = listOfDeviceIds[0]
    setInterval(getTemp.bind(null, sensor_id), temp_poll_interval)
})


// Setup power control
var power_ctrl = gpio.export(power_ctrl_pin)
power_ctrl.on('change', function(val) {
  power_state = val
  // Send data to each cnxn
  primus.forEach(function (spark) {
    spark.emit('power', val)
  });
});
