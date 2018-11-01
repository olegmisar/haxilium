import _ from 'lodash'
import assert from 'assert'
import deepFreeze from 'deep-freeze-strict'
import setImmediate from 'set-immediate-shim'

import DelegatedHaxballRoom from './delegated-haxball-room'
import { isPlayerObject, parseAccessStringWithRoles, asyncify, createEnum } from './utils'
import * as errors from './errors'


export default class Haxilium extends DelegatedHaxballRoom {
    CommandNotFoundError       = errors.CommandNotFoundError
    AccessToCommandDeniedError = errors.AccessToCommandDeniedError

    SPECT = 0
    RED = 1
    BLUE = 2
    _players = {}
    _commands = {}
    _roles = {}

    constructor(config) {
        assert(_.isObject(config), 'Please provide room config')
        super(config)
        this.state = config.state || {}
        this._initPlayers(config)
        this._resetCallbacks()
    }

    /**
     * Bind module to the room.
     * @param {Object}   module              Module object.
     * @param {Object}   module.defaultState An object where you put all module related variables. This object will be recursively merged with 'defaultState's of other modules and will be set as 'state' property of the room.
     * @param {Object}   module.methods      An object of methods which will be attached to the room. Keys of object are names of methods and values of object are methods themselves.
     * @param {Object}   module.callbacks    An object of callbacks which will be registered. Keys of object are names of events and values are callback functions or arrays of callback functions.
     * @param {Object[]} module.commands     An array of commands to register.
     */
    bindModule(module) {
        const { defaultState, methods, callbacks, commands } = module

        // Register module callbacks.
        let callbackUnbinds = []
        if (_.isObject(callbacks)) {
            callbackUnbinds = _.toPairs(callbacks).map(([eventName, callback]) =>
                this.on(eventName, callback))
        }

        // Register module methods.
        if (_.isObject(methods)) {
            _.toPairs(methods).forEach(([methodName, method]) => {
                // TODO: smarter method intersection detection.
                // assert(_.isUndefined(this[methodName]),
                //     `Module method intersection error. ${methodName} already exists on room object`)

                this.method(methodName, method)
            })
        }

        // Add commands.
        if (_.isObject(commands)) {
            // TODO: check commands intersection.
            commands.forEach(command => this.addCommand(command))
        }

        // Merge module state with current state.
        // TODO: check intersections for states.
        if (_.isObject(defaultState)) {
            this.state = _.merge(defaultState, this.state)
        }

        // TODO: unbind module.
        // return function unbindModule() {
        //     callbackUnbinds.forEach(unbind => unbind())

        // }
    }

    /**
     * Attach callbacks to the event.
     * @param  {String}                eventName Event name. Can be PascalCase, camelCase or kebab-case.
     * @param  {(Function|Function[])} callbacks Function or array of functions which will be called when event fires.
     * @return {Function}                        Unbind callbacks function. Uses to unbind just binded callbacks. No parameters.
     */
    on(eventName, callbacks) {
        callbacks = _.castArray(callbacks).map(cb => cb.bind(this))
        eventName = _.camelCase(eventName)

        assert(_.isString(eventName), 'Callback name must be a string')
        assert(callbacks.length > 0, `No callbacks provided for ${eventName} event`)
        assert(callbacks.every(_.isFunction), 'Event callbacks must be functions')

        // Attach callbacks to the event.
        this._callbacks[eventName] = (this._callbacks[eventName] || []).concat(callbacks)

        // Return detaching function.
        return () => {
            this._callbacks[eventName] = this._callbacks[eventName]
                .filter(cb => !callbacks.includes(cb))
        }
    }

    /**
     * Add method to the room object.
     * @param  {String}   methodName Name of the method.
     * @param  {Function} method     The method itself.
     */
    method(methodName, method) {
        assert(_.isString(methodName), 'Method name must be a string')
        assert(_.isFunction(method),   'Method function must be a function')
        this[methodName] = method
    }

    /**
     * Add command to room object. Later it can be called using 'executeCommand'.
     * @param {String[]} command.names   Array of names of the command.
     * @param {String    command.access  Boolean expression which determines if player can execute this command.
     *                                   Examples: '>=admin' will allow only players with 'admin' or higher role to execute command,
     *                                   '>=player && <admin' will allow command execution only for players with role higher or
     *                                   equal to 'player' and less than 'admin'.
     * @param {Function} command.execute Command execute function. Params: 'player', 'args'.
     */
    addCommand(command) {
        let { names, access: accessString = '', execute } = command

        // Validate arguments.
        assert(_.isArray(names),         "Command 'names' must be array of strings")
        assert(names.length > 0,         'Command must have at least one name')
        assert(names.every(_.isString),  `Command 'names' must be array of strings`)
        assert(_.isString(accessString), `Command 'access' must be a string but ${typeof accessString} given`)
        assert(_.isFunction(execute),    "Command 'execute' function must be a function")

        // Normalize arguments.
        names = names.map(name => name.trim().toLowerCase())
        execute = execute.bind(this)
        const _accessFn = (accessString
            ? parseAccessStringWithRoles(accessString, this._roles)
            : _.stubTrue)

        // Make and freeze command to prevent changes in it.
        command = { ...command, names, access: accessString, _accessFn, execute }
        deepFreeze(command)
        names.forEach(name => {
            this._commands[name] = command
        })
    }

    /**
     * Get command object.
     * @param  {String} commandName Name of the command.
     * @return {Object}             Command object.
     */
    getCommand(commandName) {
        return this._commands[commandName]
    }

    /**
     * Get commands that match 'filterFn' function.
     * @param  {Function} filterFn Function that filters commands.
     * @return {Object[]}          Array of commands.
     */
    getCommands(filterFn = _.stubTrue) {
        return _(this._commands)
            .filter(filterFn)
            .uniq()
            .value()
    }

    /**
     * Execute function with checking player access to it.
     * @param  {PlayerObject} player      The player who executes this command.
     * @param  {String}       rawCommand  A raw command string to parse and execute.
     */
    executeCommand(player, rawCommand = '') {
        assert(_.isString(rawCommand), `Command must be a string but ${typeof rawCommand} is given`)

        // First argument(always lowercase) is name of command.
        const args = rawCommand.trim().split(/\s+/)
        const name = args[0] = _.toLower(args[0])
        const command = this._commands[name]

        if (!command) {
            throw new this.CommandNotFoundError(`Unknown command "${name}"`)
        }

        const playerRole = this._roles[this._getPlayerRole(player)] || 0
        const canExecute = command._accessFn(playerRole)

        if (!canExecute) {
            throw new this.AccessToCommandDeniedError(
                `${player.name} isn't allowed to execute "${name}"`)
        }

        return command.execute(player, args)
    }

    /**
     * Dispatch the event.
     * @param  {String} eventName The name of event which will be dispatched.
     * @param  {Array}  args      Arguments to pass to callbacks.
     */
    dispatch(eventName, args) {
        this._executeCallbacks(eventName, args)
    }

    /**
     * Get player list with smart options.
     * @param  {Number[]} teamsOrder                Determines in which order will be teams sorted. Optional.
     * @param  {Object}   opts                      Options which will be passed to 'filter' method of player model. Optional.
     * @return {(PlayerObject[]|PlayerObject[][])}  If 'teamsOrder' is empty array than no sorting by team will be made and just array of 'PlayerObject's will be returned. Otherwise, the return value will be array of teams.
     */
    getPlayerList(teamsOrder = [], opts = {}) {
        if (!_.isArray(teamsOrder)) {
            opts = teamsOrder
            teamsOrder = []
        }

        const players = []
        for (let p of super.getPlayerList()) {
            p = this._wrapPlayer(p)
            if (this._playerFilter(p, opts)) players.push(p)
        }

        // Return just array of players.
        if (teamsOrder.length === 0) return players

        // Return array of teams.
        const teams = [[], [], []]
        teamsOrder = teamsOrder.slice(0, 3)
        for (let p of players) {
            // Get team index of returning array.
            let index = teamsOrder.indexOf(p.team)
            // If no order index is given, append team to the end.
            if (index === -1) index = teamsOrder.length
            teams[index].push(p)
        }
        return teams
    }

    /**
     * Get player by id.
     * @param  {Number}       id Id of the player to return.
     * @return {PlayerObject}    Extended player object.
     */
    getPlayer(id) {
        return this._wrapPlayer(super.getPlayer(id))
    }

    /**
     * Inits player model and extends the room object with player's setters.
     * @param {Object} config Room config.
     */
    _initPlayers(config) {
        config.player = config.player || {}

        // Expand shourcut options.
        config.player = _.mapValues(config.player, optionsOrValue =>
            _.isObject(optionsOrValue) ? optionsOrValue : { default: optionsOrValue })

        // Iterate over each setter and extend room object with it.
        _.toPairs(config.player).forEach(([propName, options]) =>
            this._initPlayerProperty(propName, options))

        // Build player factory to extend default player object.
        const defaultPlayer = _.mapValues(config.player, options => options.default)
        this._playerFactory = () => _.cloneDeep(defaultPlayer)

        // Get player roles.
        this._roles = createEnum(config.roles || [])

        // Get function which calculates player's role. Or make default one.
        this._getPlayerRole = config.getRole || (p => '')
        // Get function which filters players when getting them using 'getPlayerList'. Or make default one.
        this._playerFilter    = config.playerFilter || _.stubTrue

        assert(_.isFunction(this._getPlayerRole), "'config.getRole' must be a function")
        assert(_.isFunction(this._playerFilter),  "'player.filter' must be a function")
    }

    /**
     * Attach method to the room which sets 'propName' on player and calls callbacks.
     * @param  {String}   propName           Name of player model property.
     * @param  {Object}   options            Property options.
     * @param  {}         options.default    Default value of property.
     * @param  {Function} options.set        Optional. Property setter. First argument is player object, the rest arguments are values to set. If returns 'false' callbacks will not be called.
     * @param  {String}   options.methodName Optional. Defines a name of method which will be attached to the room.
     * @param  {String}   options.eventName  Optional. Defines a name of event which will be fired.
     * @param  {Boolean}  options.async      Optional. Default is 'true'. If it is 'true', method will be executed asynchronously.
     */
    _initPlayerProperty(propName, options) {
        // Extend 'options' with 'default options'.
        _.defaultsDeep(options, {
            set(player, value) {
                if (_.isEqual(player[propName], value))
                    return false
                player[propName] = value
            },
            methodName: _.camelCase(`set-player-${propName}`),
            eventName: _.camelCase(`player-${propName}-change`),
            async: true
        })
        options.set = options.set.bind(this)

        // Define setter which will be attached to the room.
        let method = (id, ...values) => {
            let player = this.getPlayer(id)
            if (!player) return

            // Set and save player's properties.
            const setterReturn = options.set(player, ...values)
            this._players[id] = player
            if (setterReturn !== false) {
                // Send player copy to the callbacks.
                player = _.cloneDeep(player)
                this._executeCallbacks(options.eventName, [player])
            }
        }

        method = options.async ? asyncify(method) : method
        this.method(options.methodName, method)
    }

    /**
     * Delete callbacks which are present and (re)set default callbacks.
     */
    _resetCallbacks() {
        this._callbacks = {}

        this.on('room-link', () => this._executeCallbacks('ready'))

        this.on('playerLeave', player => setImmediate(() => {
            delete this._players[player.id]
        }))
    }

    /**
     * Execute callbacks which are binded to specific event.
     * @param  {String} eventName    Name of the event which is fired.
     * @param  {Array}  callbackArgs Array of arguments which are passed to the callbacks.
     * @return {(Boolean|Undefined)} Returns 'false' if some callback returns 'false', otherwise 'undefined'.
     */
    _executeCallbacks(eventName, callbackArgs = []) {
        eventName = _.camelCase(eventName)
        const callbacks = this._callbacks[eventName]
        if (!callbacks) return

        // Freeze args to prevent changes in them.
        deepFreeze(callbackArgs)

        // Store all results of calls of callbacks.
        const cbReturns = []
        for (let i = 0; i < callbacks.length; i++) {
            try {
                // Execute callback and push result to all results.
                cbReturns.push(callbacks[i](...callbackArgs))
            } catch (err) {
                console.error(err)
                this.sendChat('WARNING! There is an error in the code!')
            }
        }
        // If some callback has returned 'false' then return false
        if (cbReturns.some(value => value === false)) return false
    }

    /**
     * All arguments which are passed to callbacks are piped through this function.
     * It loops over each argument and wraps this argument if it is player object.
     * @param  {Array} args The arguments to be piped through.
     * @return {Array}      New wrapped arguments.
     */
    _wrapArguments(args) {
        const newArgs = []
        for (let arg of args) {
            const newArg = isPlayerObject(arg) ? this._wrapPlayer(arg) : arg
            newArgs.push(newArg)
        }
        return newArgs
    }

    /**
     * Extend player instance with additional properties.
     * @param  {PlayerObject} rawPlayer Raw player object which will be extended.
     * @return {PlayerObject}           Extended player object.
     */
    _wrapPlayer(rawPlayer) {
        // If player's additional properties don't exist yet, create them.
        if (!this._players[rawPlayer.id])
            this._players[rawPlayer.id] = this._playerFactory()
        // Merge player and additional properties.
        return { ...this._players[rawPlayer.id], ...rawPlayer }
    }
}
