"use strict";
module.exports = class Controller {
  constructor (options) {
    this.goal_temp = options.goal_temp  // Target temperature
    this.pid_ctrlr = options.pid_ctrlr  // Instance of node-pid-controller
    this.period_length = options.period_length || 100  // Length, in seconds, of each PWM period
    this.power_ctrl = options.power_ctrl  // gpio controller
    this.socket_server = options.socket_server
    this.run_length = options.run_length || 60 * 60 * 3 // Length, in seconds, of total runtime

    this.last_temp = options.last_temp
    this.controlId = null  // Placeholder for ID returned by setTimeout / setInterval
  }

  start () {
    console.log("Starting")
    return new Promise (
      this.warmUp.bind(this)
    ).then(
      this.runCtrl.bind(this),
      function (error) {
        console.error('uh oh: ', error);
    })
  }

  end () {
    // TODO Kill current controlID value

  }

  get isRunning () {
    return this.controlId ? true : false
  }

  get startTime () {
    if (!this._startTime) {
      this._startTime = new Date()
    }
    return this._startTime
  }

  warmUp (resolve, reject) {
    var last_temp = this.last_temp
    var retry = this.warmUp.bind(this, resolve, reject)

    if (!last_temp) {
      console.log("No known temp, trying again in 1 sec")
      this.controlId = setTimeout(retry, 1000)
      return
    }

    var temp_offset = this.goal_temp - last_temp

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
      this.controlId = setTimeout(retry, 30000)
      return
    }
  }

  runCtrl () {
    try {
      var runtime = new Date() - this.startTime
      if ((runtime / 1000) > this.run_length ) {
        console.log("Trial ended.")
      }

      // Get new duty cycle
      var duty_cycle = this.pid_ctrlr.update(this.last_temp)
      console.log("Update duty cycle", duty_cycle)

      // Send data to each cnxn
      this.socket_server.forEach(function (spark) {
        spark.emit('duty', new Date(), duty_cycle, this.pid_ctrlr.k_p, this.pid_ctrlr.k_i, this.pid_ctrlr.k_d);
      }.bind(this))

      // Apply duty cycle
      // NOTE: Should this be a promise?
      return this.runCycle(duty_cycle, 0)
    } catch (err) {
      console.log(err.stack) // NOTE Why doesn't this log by default?
      throw err
    }
  }

  runCycle (duty, cycle_num) {
    try {
      if (cycle_num < this.period_length) {
        // Control power for cycle
        var rel_duty = (duty/100) * this.period_length
        this.power_ctrl.set((rel_duty > cycle_num) ? 1 : 0)
        this.controlId = setTimeout(this.runCycle.bind(this, duty, cycle_num + 1), 1000)
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
