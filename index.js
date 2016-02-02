var compression = require('compression')
var ds18x20 = require('ds18x20')
var express = require("express")
var gpio = require("gpio");
var http = require("http")
var Primus = require("primus")
var PIDController = require('node-pid-controller');

var BroadcastLogs = require('./lib/broadcast-logs')
var Controller = require('./lib/control-system')

// Global Variables
var port = process.env.PORT || 3000
var power_ctrl_pin = process.env.PWR_CTRL_PIN || 17
var temp_poll_interval = process.env.POLL_INTERVAL || 1000
var last_temp
var power_state = 0
var controlId = {val: 0, running: false}
var target_temp
var ctrlr

// Setup temperature sensor
function getTemp (sensor_id) {
  ds18x20.get(sensor_id, function (err, temp) {
    // No need to transmit redundant data
    if (temp == last_temp) {
      return
    }
    if (ctrlr) {
      ctrlr.last_temp = temp
    }
    // Send data to each cnxn
    primus.forEach(function (spark) {
      // TODO: Send PID values with temp
      spark.emit('temp', temp, new Date(), power_state);
    })
    last_temp = temp
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
  console.log('Turned device', parseInt(val) ? 'on' : 'off')
  // Send data to each cnxn
  primus.forEach(function (spark) {
    spark.emit('power', val)
  });
});

// Setup app
var app = express()
app.use('/', express.static(__dirname + '/public'))
app.use(compression())

// Set up webserver
var server = http.createServer(app)
server.listen(port)

// Setup socket
var primus = Primus(server, { transformer: "engine.io" })
primus.use('emit', require('primus-emit'))

// Set up logs to broadcast
BroadcastLogs(console, 'log', primus, 'msg-log')
BroadcastLogs(console, 'error', primus, 'msg-error')

primus.on('connection', function (spark) {
  console.log('client ' + spark.id + ' has connected to the server')

  // Send initial state
  spark.emit('power', power_ctrl._get())
  spark.emit('temp', last_temp, new Date(), power_state)
  spark.emit('runControl', controlId.running, target_temp)

  // Handle manual power override signal
  spark.on('power', function power (val) {
    power_ctrl.set(parseInt(val))
  });

  // Handle manual power override signal
  spark.on('runControl', function runControl (state, target_temp) {
    if (parseInt(state)) {
      target_temp = parseInt(target_temp)
      var pid_ctrlr = new PIDController({
        k_p: 1,
        k_i: 1,
        k_d: 1,
      })
      pid_ctrlr.setTarget(target_temp)

      ctrlr = new Controller({
        goal_temp: target_temp,
        pid_ctrlr: pid_ctrlr,
        power_ctrl: power_ctrl,
        socket_server: primus,
        last_temp: last_temp
      })
      ctrlr.start()
    } else {
      clearTimeout(controlId.val)
      controlId.val = 0
      power_ctrl.set(0)
      console.log("Stopped control cycle")
    }
  });
})
primus.on('disconnection', function (spark) {
  console.log('client ' + spark.id + ' has disconnected to the server')
})
// Notify server when control value changes
Object.observe(controlId, function (changes) {
  controlId.running = controlId.val ? true : false
  primus.forEach(function (spark) {
    spark.emit("runControl", controlId.running)
  })
})
