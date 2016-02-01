module.exports = class Controller {
  constructor (options) {
    this.goal_temp = options.goal_temp  // Target temperature
    this.temp_window = options.temp_window || 5  // Proximity to goal_temp needed before PID loop beings
    this.pid_ctrlr = options.pid_ctrlr  // Instance of node-pid-controller
    this.period_length = options.period_length || 100  // Length, in seconds, of each PWM period
    this.power_ctrl = options.power_ctrl  // gpio controller
    this.socket_server = options.socket_server
    this.run_length = options.run_length || 60 * 60 * 3 // Length, in seconds, of total runtime

    this.last_temp = null
    this.controlId = null  // Placeholder for ID returned by setTimeout / setInterval
  }

  start () {
    return new Promise ( this.warmUp ).then( runCtrl )
  }

  end () {

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
    var retry = this.warmUp.bind(resolve, reject)

    if (!last_temp) {
      console.log("No known temp, trying again in 1 sec")
      this.controlId = setTimeout(retry, 1000)
      return
    }

    var temp_offset = this.goal_temp - last_temp

    if (Math.abs(temp_offset) < this.temp_window) {
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
    var runtime = new Date() - this.startTime
    if ((runtime / 1000) > this.run_length ) {
      console.log("Trial ended.")
    }

    // Get new duty cycle
    duty_cycle = this.pid_ctrlr.update(this.last_temp)

    // Send data to each cnxn
    this.socket_server.forEach(function (spark) {
      spark.emit('duty', duty_cycle, new Date(), power_state);
    })
    console.log('duty_cycle', duty_cycle)

    // Apply duty cycle
    // NOTE: Should this be a promise?
    return this.runCycle(duty_cycle)
  }

  runCycle (duty, cycle_num = 0) {
    if (cycle_num < period_length) {
      // Control power for cycle
      var rel_duty = (duty/100) * this.period_length
      power_ctrl.set((rel_duty > cycle_num) ? 1 : 0)
      this.controlId = setTimeout(runCycle.bind(this, duty, cycle_num + 1), 1000)
      return
    } else {
      // End of cycle
      return this.runCtrl()
    }
  }
}
