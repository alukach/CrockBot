"use strict";
module.exports = class Controller {
  constructor (options) {
    this.target_temp = options.target_temp  // Target temperature
    this.pid_ctrlr = options.pid_ctrlr  // Instance of node-pid-controller
    this.period_length = options.period_length || 100  // Length, in seconds, of each PWM period
    this.power_ctrl = options.power_ctrl  // gpio controller
    this.socket_server = options.socket_server
    this.run_length = options.run_length || 60 * 60 * 3 // Length, in seconds, of total runtime

    this.last_temp = options.last_temp
    this.timeoutObject = null  // Placeholder for ID returned by setTimeout / setInterval
    this.isRunning = false
    this.status = "Off"
  }

  start () {
    console.log("Starting PID controller")
    this.isRunning = true
    return new Promise (
      this.warmUp.bind(this)
    ).then(
      this.runCtrl.bind(this),
      function (error) {
        console.error('uh oh: ', error);
    })
  }

  stop () {
    console.log("Stopping PID controller")
    this.power_ctrl.set(0)
    this.isRunning = false
    this.status = "Off"
    clearTimeout(this.timeoutObject)
    this.emit_state()
  }

  get startTime () {
    if (!this._startTime) {
      this._startTime = new Date()
    }
    return this._startTime
  }

  get state () {
    return {
      isRunning: this.isRunning,
      target_temp: this.target_temp,
      k_p: this.pid_ctrlr.k_p,
      k_i: this.pid_ctrlr.k_i,
      k_d: this.pid_ctrlr.k_d,
      duty: this.duty_cycle,
      status: this.status,
    }
  }

  emit_state () {
    this.socket_server.forEach(function (spark) {
      spark.emit('ctrlr_state', this.isRunning ? this.state : false)
    }.bind(this))
  }

  warmUp (resolve, reject) {
    this.status = "Warming"
    var last_temp = this.last_temp
    var retry = this.warmUp.bind(this, resolve, reject)

    if (!last_temp) {
      console.log("No known temp, trying again in 1 sec")
      this.timeoutObject = setTimeout(retry, 1000)
      return
    }

    var temp_offset = this.target_temp - last_temp

    if (Math.abs(temp_offset) < this.pid_ctrlr.k_p) {
      console.log("Within temp, starting...")
      return resolve()

    } else {
      if (temp_offset > 0) {
        console.log("Under temp, currently at", last_temp, "need to rise by", temp_offset.toFixed(1), "degrees.")
        this.power_ctrl.set(1)

      } else {
        console.log("Over temp, currently at", last_temp, "need to lower by", Math.abs(temp_offset).toFixed(1), "degrees.")
        this.power_ctrl.set(0)
      }
      this.timeoutObject = setTimeout(retry, 30000)
      return
    }
  }

  runCtrl () {
    this.status = "Running"
    try {
      var runtime = new Date() - this.startTime
      if ((runtime / 1000) > this.run_length ) {
        console.log("Trial ended.")
      }

      // Get new duty cycle
      var duty_cycle = this.pid_ctrlr.update(this.last_temp)
      this.duty_cycle = parseFloat(duty_cycle.toPrecision(2))
      console.log("Update duty cycle", this.duty_cycle, this.pid_ctrlr.k_p, this.pid_ctrlr.k_i, this.pid_ctrlr.k_d)

      // Send data to each cnxn
      this.emit_state()

      // Apply duty cycle
      // NOTE: Should this be a promise?
      return this.runCycle(0)
    } catch (err) {
      console.log(err.stack) // NOTE Why doesn't this log by default?
      throw err
    }
  }

  runCycle (cycle_num) {
    try {
      if (cycle_num < this.period_length) {
        // Control power for cycle
        var rel_duty = (this.duty_cycle/100) * this.period_length
        this.power_ctrl.set((rel_duty > cycle_num) ? 1 : 0)
        this.timeoutObject = setTimeout(this.runCycle.bind(this, cycle_num + 1), 1000)
        return
      } else {
        // End of cycle
        return this.runCtrl()
      }
    } catch (err) {
      console.log(err.stack) // NOTE Why doesn't this log by default?
      throw err
    }
  }
}
