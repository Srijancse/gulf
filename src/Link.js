/**
 * gulf - Sync anything!
 * Copyright (C) 2013-2016 Marcel Klehr <mklehr@gmx.net>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 *  along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
var Duplex = require('stream').Duplex
var debug = require('debug')('gulf')
require('setimmediate')
var SECONDS = 1000

/**
 * This is a Link
 * The public should interact with it via node's streams API (ie. using .pipe etc.)
 * Internally, it emits events ("link:*") that are picked up by the Document it is attached to.
 */
function Link (opts) {
  if(!opts) opts = {}
  this.timeout = opts.timeout || 10*SECONDS
  this.localTransmissionId = 0
  this.lastRemoteTransmissionId = null
  this.credentials = opts.credentials
  this.authenticateFn = opts.authenticate
  this.authorizeReadFn = opts.authorizeRead
  this.authorizeWriteFn = opts.authorizeWrite
  this.authenticated
  this.sentEdit
  this.sentRequestInit
  this.queue
  this.linkBuffer = ''

  Duplex.call(this, {allowHalfOpen: false, objectMode: true})

  this.on('error', function(er) {
    debug('Error in link', 'undefined'!=typeof window? er : er.stack || er)
  }.bind(this))

  this.on('editError', function(er) {
    debug('EditError in link', 'undefined'!=typeof window? er : er.stack || er)
  })

  this.reset()
}
Link.prototype = Object.create(Duplex.prototype, { constructor: { value: Link }})

module.exports = Link

Link.prototype.reset = function() {
  this.queue = []
  if(this.sentEdit) clearTimeout(this.sentEdit.timeout)
  this.sentEdit = null
}

/**
 * Pipeline an event
 * Please, Don't send edits with this method! Use .sendEdit() to queue it, like everyone else.
 */
Link.prototype.send = function(event/*, args..*/) {
  if('requestInit' === event) this.sentRequestInit = true

  var msg = Array.prototype.slice.call(arguments)

  // Authorize message
  this.authorizeRead(msg)
  .then(authorized =>  {
    // If unauthorized, tell them
    if(!authorized) return this.sendUnauthorized()

    // If this is an edit, add a timeout, after which we retry
    if('edit' === event) {
      var edit = msg[1]
        , cb = edit.callback
      var timeout = setTimeout(() => {
        this.send('edit', edit)
      }, this.timeout)
      edit.callback = function() {
        clearTimeout(timeout)
        cb && cb.apply(null, arguments)
      }
      msg[1] = edit.toJSON()
    }

    var data = JSON.stringify(msg)
    debug('->', data)
    this.push(data+'\n')
  })
  .catch(e => {
    this.emit('error', er) 
  })
}

Link.prototype.sendUnauthenticated = function() {
  this.push(JSON.stringify(['unauthenticated'])+'\n')
}

Link.prototype.sendAuthenticate = function() {
  this.push(JSON.stringify(['authenticate', this.credentials])+'\n')
}

Link.prototype.sendAuthenticated = function(status) {
  this.push(JSON.stringify(['authenticated', status])+'\n')
}

Link.prototype.sendUnauthorized = function() {
  this.push(JSON.stringify(['unauthorized'])+'\n')
}

/*
 * Put an edit into the queue
 * @param edit {Edit} the edit to send through this link
 * @param cb {Function} Get callback when the edit has been acknowledged (optional)
 */
Link.prototype.sendEdit = function(edit) {
  // Create promise and attach callback (to be resolved once the ACK arrives)
  const promise = new Promise((resolve) => edit.callback = resolve)

  // Attach transmissionId
  edit.transmissionId = ++this.localTransmissionId

  if(this.queue.length || this.sentEdit) {
    this.queue.push(['edit', edit])
  }
  else {
    this.sentEdit = edit
    this.send('edit', edit)
  }
  return promise
}

Link.prototype.sendAck = function(editId) {
  if(this.queue.length || this.sentEdit) {
    this.queue.push(['ack', editId])
  }
  else {
    this.send('ack', editId)
  }
}

// This is only used to push edits from the queue into the pipeline.
// All other events are pushed directly in .send()
Link.prototype._read = function() {
  if(this.sentEdit) return
  if(!this.queue[0]) return
  var msg
  while(msg = this.queue.shift()) {
    if('edit' === msg[0]) {
      this.sentEdit = msg[1]
    }

    this.send.apply(this, msg)
    if('edit' === msg[0]) break
  }
}

Link.prototype._write = function(buf, enc, cb) {
  this.linkBuffer += buf.toString()
  var idx = this.linkBuffer.indexOf('\n')
  if (idx === -1) return cb()
  var msgs = []
  while (idx !== -1) {
    msgs.push(this.linkBuffer.substr(0, idx))
    this.linkBuffer = this.linkBuffer.substr(idx+1)
    idx = this.linkBuffer.indexOf('\n')
  }
  iterate.apply(this)
  function iterate(er) {
    if (er) return cb(er)
    if (!msgs.length) return cb()
    this.onwrite(msgs.shift(), iterate.bind(this))
  }
}

Link.prototype.onwrite = function(data, cb) {
  debug('<- _write:', data)
  var args = JSON.parse(data)

  // ['authenticate', Mixed]
  if(args[0] === 'authenticate') {
    this.authenticate(args[1])
    .then((authed) => {
      this.authenticated = authed
      this.sendAuthenticated(!!authed)
      cb()
    }, (error) => {
      this.emit('error', error)
    })
    return
  }

  // ['authenticated', Bool]
  if(args[0] === 'authenticated') {
    if(!args[1]) return this.emit('error', new Error('Authentication failed'))
    if(this.sentRequestInit) this.send('requestInit')
    else if(this.sentEdit) this.send('edit', this.sentEdit)
    cb()
    return
  }

  // ['unauthenticated']
  if(args[0] === 'unauthenticated') {
    this.sendAuthenticate()
    cb()
    return
  }

  // ['unauthorized']
  if(args[0] === 'unauthorized') {
    this.send('requestInit')
    cb()
    return
  }

  if(!this.authenticated && this.authenticateFn) {
    this.sendUnauthenticated()
    cb()
    return
  }

  if(args[0] === 'init') {
    this.sentRequestInit = false
  }

  this.authorizeWrite(args)
  .then((authorized) => {
    if(!authorized) {
      this.sendUnauthorized()
      return
    }

    // Intercept acks for shifting the queue and calling callbacks
    if(args[0] == 'ack') {
      var id = args[1]

      if(this.sentEdit && typeof(this.sentEdit.callback) == 'function') {
        // Callback
        this.sentEdit.id = id
        // The nextTick shim for browsers doesn't seem to enforce the call order
        // (_read is called below and they must be in that order), so we call directly
        //nextTick(this.sentEdit.callback.bind(null, null, this.sentEdit))
        try {
          this.sentEdit.callback(this.sentEdit)
        }catch(e) {
          this.emit('error', e)
        }
        delete this.sentEdit.callback
      }
      this.sentEdit = null

      setImmediate(function() {
        this._read(0)
      }.bind(this))
    }

    if (args[0] === 'edit') {
      if (this.lastRemoteTransmissionId && args[1].transmissionId === this.lastRemoteTransmissionId) {
        return
      }
      this.lastTransmissionId = args[1].transmissionId
    }

    args[0] = 'link:'+args[0]
    this.emit.apply(this, args)
  })
  .then(cb)
  .catch((e) => {
    this.emit('error', e)
  })
}

Link.prototype.authenticate = function(credentials) {
  return this.authenticateFn(credentials)
}

Link.prototype.authorizeWrite = function(msg) {
  if(!this.authorizeWriteFn) return Promise.resolve(true)
  return this.authorizeWriteFn(msg, this.authenticated)
}

Link.prototype.authorizeRead = function(msg) {
  if(!this.authorizeReadFn) return Promise.resolve(true)
  return this.authorizeReadFn(msg, this.authenticated)
}
