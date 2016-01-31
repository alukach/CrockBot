var compression = require('compression')
var ds18x20 = require('ds18x20')
var express = require("express")
var gpio = require("gpio");
var http = require("http")
var Primus = require("primus")
var Controller = require('node-pid-controller');

var BroadcastLogs = require('./lib/broadcast-logs')

// Global Variables
var port = process.env.PORT || 3000
var power_ctrl_pin = process.env.PWR_CTRL_PIN || 17
var temp_poll_interval = process.env.POLL_INTERVAL || 1000
var last_temp
var power_state = 0
var controlId = {val: 0, running: false}
var current_target_temp


// Setup temperature sensor
function getTemp (sensor_id) {
  ds18x20.get(sensor_id, function (err, temp) {
    // No need to transmit redundant data
    if (temp == last_temp) {
      return
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
  spark.emit('runControl', controlId.running, current_target_temp)

  // Handle manual power override signal
  spark.on('power', function power (val) {
    power_ctrl.set(parseInt(val))
  });

  // Handle manual power override signal
  spark.on('runControl', function runControl (state, target_temp) {
    if (parseInt(state)) {
      current_target_temp = parseInt(target_temp)
      var ctrlr = new Controller({
        k_p: 1,
        k_i: 1,
        k_d: 1,
      })
      ctrlr.setTarget(target_temp)

      // Warm up to within 5 deg, then run control system
      var cycle_length = 5
      controlId.val = startControl(last_temp, target_temp, 5, ctrlr, cycle_length, power_ctrl)
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

// Run control system
function startControl (last_temp, goal_temp, temp_window, ctrlr, cycle_length, power_ctrl) {
  // Warm machine up to within 5 degrees, then run callback (entering
  // control system).
  if (!last_temp) {
    console.log("No known temp, trying again in 1 sec")
    controlId.val = setTimeout(startControl.bind(null, last_temp, goal_temp, temp_window, ctrlr, cycle_length, power_ctrl), 1000)
    return controlId.val
  }

  var temp_offset = goal_temp - last_temp

  if (Math.abs(temp_offset) < temp_window) {
    console.log("Within temp, starting...")
    return runCtrl(ctrlr, cycle_length, new Date())

  } else {

    if (temp_offset > 0) {
      console.log("Under temp, currently at", last_temp, "need to rise by", temp_offset.toFixed(1), "degrees.")
      power_ctrl.set(1)

    } else {
      console.log("Over temp, currently at", last_temp, "need to lower by", Math.abs(temp_offset).toFixed(1), "degrees.")
      power_ctrl.set(0)
    }

    controlId.val = setTimeout(startControl.bind(null, last_temp, goal_temp, temp_window, ctrlr, cycle_length, power_ctrl), 30000)
    return controlId.val
  }
}

function runCtrl (ctrlr, cycle_length, last_temp, start) {
  start = start || new Date()  // Set start time if unset
  if (((new Date() - start) / 1000) < (60 * 60 * 3) ) {  // Run for 3 hr
    duty_cycle = ctrlr.update(last_temp)
    // Send data to each cnxn
    primus.forEach(function (spark) {
      spark.emit('duty', duty_cycle, new Date(), power_state);
    })

    console.log('duty_cycle', duty_cycle)
    var callback = runCtrl.bind(null, ctrlr, cycle_length, start)
    controlId.val = setTimeout(runCycle.bind(null, duty_cycle, 0, cycle_length, callback), 1000)
    return controlId.val
  }
  else {
    console.log("Trial ended.")
  }
}

function runCycle (duty, cycle_num, cycle_length, callback) {
  if (cycle_num < cycle_length) {
    // Control power for cycle
    var rel_duty = (duty/100) * cycle_length
    power_ctrl.set((rel_duty > cycle_num) ? 1 : 0)
    controlId.val = setTimeout(runCycle.bind(null, duty, cycle_num + 1, cycle_length, callback), 1000)
    return controlId.val
  } else {
    // End of cycle
    return callback()
  }
}
