console.log("Starting...")
var compression = require('compression')
var ds18x20 = require('ds18x20')
var express = require("express")
var gpio = require("gpio")
var http = require("http")
var Primus = require("primus")
var PIDController = require('node-pid-controller')

var BroadcastLogs = require('./lib/broadcast-logs')
var Controller = require('./lib/control-system')

// Global Variables
var port = process.env.PORT || 3000
var power_ctrl_pin = process.env.PWR_CTRL_PIN || 17
var temp_poll_interval = process.env.POLL_INTERVAL || 1000
var power_state = 0
var last_temp, target_temp, pid_ctrlr, ctrlr
var k_p = 10
var k_i = 600
var k_d = 0


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
      spark.emit('temp', temp, new Date(), power_state)
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
  })
})

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
  console.log('ctrlr_state', ctrlr ? ctrlr.state : false)
  spark.emit('ctrlr_state', ctrlr ? ctrlr.state : false)

  // Handle manual power override signal
  spark.on('power', function power (val) {
    power_ctrl.set(parseInt(val))
  })

  // Handle entering control loop
  spark.on('ctrlr_state', function runControl (state) {
    if (Boolean(state)) {
      target_temp = parseInt(state.target_temp)
      var pid_ctrlr = new PIDController({
        k_p: k_p,
        k_i: k_i,
        k_d: k_d,
      })
      pid_ctrlr.setTarget(target_temp)

      ctrlr = new Controller({
        target_temp: target_temp,
        pid_ctrlr: pid_ctrlr,
        power_ctrl: power_ctrl,
        socket_server: primus,
        last_temp: last_temp
      })
      ctrlr.start()
      console.log(target_temp)
      primus.forEach(function (spark) {
        spark.emit('runControl', ctrlr ? ctrlr.isRunning : false, target_temp)
      })
    } else {
      ctrlr.stop()
    }
  })
})
primus.on('disconnection', function (spark) {
  console.log('client ' + spark.id + ' has disconnected to the server')
})
// Notify server when control value changes
// Object.observe(ctrlr.isRunning, function (changes) {
//   // TODO: Update code to set controlId
//   primus.forEach(function (spark) {
//     spark.emit("runControl", ctrlr.isRunning)
//   })
// })

console.log("Ready to Crock!")
