module.exports = function BroadcastLogs(target, method, socketServer, eventName) {
  var originalFunction = target[method]
  // process.stdout.write(target[method])
  // replace method with spy method
  target[method] = function() {
    var args = Array.prototype.slice.call(arguments)
    args.unshift(new Date())
    args.unshift(eventName)
    socketServer.forEach(function (spark) {
      spark.emit.apply(spark, args);
    })
    return originalFunction.apply(this, arguments) // invoke original function
  }
}
