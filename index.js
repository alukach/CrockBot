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
var controlId


// Setup app
var app = express()
app.use('/', express.static(__dirname + '/public'))


// Set up webserver
var server = http.createServer(app)
server.listen(port)

function log_msg (socketServer, msg) {
  var args = Array.prototype.slice.call(arguments)
  args = args.slice(1, args.length)
  args.unshift(new Date())
  args.unshift('msg')
  socketServer.forEach(function (spark) {
    spark.emit.apply(spark, args)
  })
}

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

  // Handle manual power override signal
  spark.on('power', function power (val) {
    power_ctrl.set(parseInt(val))
  });

  // Handle manual power override signal
  spark.on('start_cycle', function start_cycle (target_temp, cycle_length) {
    cycle_length = cycle_length || 50;
    var start = new Date()

    // Setup ctrlr
    var ctrlr = new Controller({
      k_p: 0.5,
      k_i: 0.01,
      k_d: 0.01,
    });
    ctrlr.setTarget(target_temp);

    // Warm up to within 5 deg, then run control system
    warmUp(target_temp, 5, runCtrl.bind(null, ctrlr, cycle_length))
  });

  // Handle manual power override signal
  spark.on('stop_cycle', function stop_cycle () {
    clearTimeout(controlId)
    power_ctrl.set(0)
    console.log("Stopped control cycle")
  });
})
primus.on('disconnection', function (spark) {
  console.log('client ' + spark.id + ' has disconnected to the server')
})


// Setup temperature sensor
function getTemp (sensor_id) {
  ds18x20.get(sensor_id, function (err, temp) {
    // No need to transmit redundant data
    if (temp == last_temp) {
      return
    }
    // Send data to each cnxn
    primus.forEach(function (spark) {
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


// Run control system
function warmUp (goal_temp, temp_window, callback) {
  // Warm machine up to within 5 degrees, then run callback (entering
  // control system).
  if (!last_temp) {
    console.log("No known temp, trying again in 1 sec")
    controlId = setTimeout(warmUp.bind(null, goal_temp, temp_window, callback), 1000)
    return controlId
  }
  var temp_offset = goal_temp - last_temp
  if (Math.abs(temp_offset) < temp_window) {
    console.log("Within temp, starting...")
    return callback()
  } else {
    if (temp_offset > 0) {
      console.log("Under temp, currently at", last_temp, "need to rise by", temp_offset.toFixed(1), "degrees.")
      power_ctrl.set(1)
    } else {
      console.log("Over temp, currently at", last_temp, "need to lower by", Math.abs(temp_offset).toFixed(1), "degrees.")
      power_ctrl.set(0)
    }
    controlId = setTimeout(warmUp.bind(null, goal_temp, temp_window, callback), 30000)
    return controlId
  }
}
function runCtrl (ctrlr, cycle_length, start) {
  start = start || new Date()  // Set start time if unset
  if (((new Date() - start) / 1000) < (60 * 60 * 3) ) {  // Run for 3 hr
    duty_cycle = ctrlr.update(last_temp)
    // Send data to each cnxn
    primus.forEach(function (spark) {
      spark.emit('duty', duty_cycle, new Date(), power_state);
    })

    console.log('duty_cycle', duty_cycle)
    var callback = runCtrl.bind(null, ctrlr, cycle_length, start)
    controlId = setTimeout(runCycle.bind(null, duty_cycle, 0, cycle_length, callback), 1000)
    return controlId
  }
  else {
    log_msg("Trial ended.")
  }
}
function runCycle (duty, cycle_num, cycle_length, callback) {
  if (cycle_num < cycle_length) {
    // Control power for cycle
    var rel_duty = (duty/100) * cycle_length
    power_ctrl.set((rel_duty > cycle_num) ? 1 : 0)
    controlId = setTimeout(runCycle.bind(null, duty, cycle_num + 1, cycle_length, callback), 1000)
    return controlId
  } else {
    // End of cycle
    return callback()
  }
}
