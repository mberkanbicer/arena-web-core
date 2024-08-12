/**
 * @fileoverview Register as a runtime; Send requests to orchestrator
 *
 * Open source software under the terms in /LICENSE
 * Copyright (c) 2021, The CONIX Research Center. All rights reserved.
 * @date 2022
 */
import { UUID } from 'uuidjs';
import MQTTClient from './mqtt-client';
import RuntimeMsgs from './runtime-msgs';
import { ARENA_EVENTS } from '../../../constants';

/**
 * Send requests to orchestrator: register as a runtime, create modules from persist objects.
 * TODO: start modules on the browser
 * (code from https://github.com/SilverLineFramework/runtime-browser/)
 */
export default class RuntimeMngr {
    /* singleton instance */
    static instance = null;

    /* @property {object} [mc=null] - mqtt client instance */
    mc;

    /* @property {string} [realm="realm"] - realm to use */
    realm;

    /* @property {string} [uuid=uuid4()] - runtime uuid */
    uuid;

    /* @property {string} [name="rt-XXXXX@Browser"] - runtime name */
    name;

    /* @property {number} [maxNmodules=10] - maximum number of modules */
    maxNmodules;

    /* @property {string[]} [apis=[]] - apis supported by the runtime (TODO: add apis once we support running modules) */
    apis;

    /* @property {string} [regTopic="realm/proc/reg"] - pubsub topic where the runtime sends register messages */
    regTopic;

    /*  @property {string} [ctlTopic="realm/proc/ctl"] - pubsub topic where the runtime listens for control messages (module create/delete) */
    ctlTopic;

    /* @property {string} [dbgTopic="realm/proc/debug"] - pubsub topic where the runtime sends/receives output (stdout/stdin) */
    dbgTopic;

    /* @property {number} [regTimeoutSeconds=30] - how long we wait for responses to register msgs */
    regTimeoutSeconds;

    /* @property {number} regRequestUuid - last registration request identifier; to check upon chegistration confirmation */
    regRequestUuid;

    /* @property {boolean} [isRegistered=false] - if true, indicates the runtime is already registered */
    isRegistered;

    /* @property {rtInitCallback} [onInitCallback] - callback when the runtime is done initializing/registering */
    onInitCallback;

    /* @property {string} [fsLocation="/store/users/"] - filestore location, for program files */
    fsLocation;

    /* @property {array} [modules=[]] - list of modules running */
    modules;

    /* @property {array} [pendingModulesArgs=[]] - list of create arguments for modules waiting to be started (waiting for runtime init) */
    pendingModulesArgs;

    /* @property {array} [clientModules=[]] - list of client modules that need to be deleted when the client finishes */
    clientModules;

    /* @property {boolean} [debug=false] - debug flag; more verbose console.log */
    debug;

    /**
     * Start runtime manager
     * @param {object} mc -  mqtt client object
     * @param {boolean} debug - debug messages on/off
     */
    constructor({
        mqttHost = 'wss://arenaxr.org/mqtt/',
        mqttUsername = 'noauth',
        mqttToken = 'noauth',
        realm = 'realm',
        uuid = UUID.generate(),
        name = `rt-${(Math.random() + 1).toString(36).substring(2)}`,
        maxNmodules = 0, // TMP: cannot run any modules
        apis = [],
        regTopic = `${realm}/proc/reg`,
        ctlTopic = `${realm}/proc/control`,
        dbgTopic = `${realm}/proc/debug`,
        regTimeoutSeconds = 5,
        onInitCallback = null,
        fsLocation = '/store/users/',
        debug = false,
    }) {
        // singleton
        if (RuntimeMngr.instance) {
            return RuntimeMngr.instance;
        }
        RuntimeMngr.instance = this;

        this.mqttHost = mqttHost;
        this.mqttUsername = mqttUsername;
        this.mqttToken = mqttToken;
        this.realm = realm;
        this.uuid = uuid;
        this.name = name;
        this.maxNmodules = maxNmodules;
        this.apis = apis;
        this.regTopic = regTopic;
        this.ctlTopic = ctlTopic;
        this.dbgTopic = dbgTopic;
        this.regTimeoutSeconds = regTimeoutSeconds;
        this.onInitCallback = onInitCallback;
        this.fsLocation = fsLocation;
        this.debug = debug;

        this.modules = [];
        this.pendingModulesArgs = [];
        this.clientModules = [];
        this.isRegistered = false;

        // instanciate runtime messages factory
        this.rtMsgs = new RuntimeMsgs(this);

        // create a last will message (delete runtime)
        this.lastWillStringMsg = JSON.stringify(this.rtMsgs.deleteRuntime());

        // on unload, send delete client modules requests
        const rt = this;
        window.onbeforeunload = rt.cleanup;       
        
        // listen to program "refresh" key combination
        window.addEventListener("keyup", (e) => {
            if (e.altKey && e.shiftKey && e.which == 80) {
                RuntimeMngr.instance.reload(true);
            }
        });

    }

    setOptions({
        realm = this.realm,
        name = this.name,
        maxNmodules = this.maxNmodules,
        apis = this.apis,
        regTopic = this.regTopic,
        ctlTopic = this.ctlTopic,
        dbgTopic = this.dbgTopic,
        regTimeoutSeconds = this.regTimeoutSeconds,
        onInitCallback = this.onInitCallback,
        fsLocation = this.fsLocation,
        debug = this.debug,
    }) {
        // TODO: handle changes
        this.realm = realm;
        this.name = name;
        this.maxNmodules = maxNmodules;
        this.apis = apis;
        this.regTopic = regTopic;
        this.ctlTopic = ctlTopic;
        this.dbgTopic = dbgTopic;
        this.regTimeoutSeconds = regTimeoutSeconds;
        this.onInitCallback = onInitCallback;
        this.fsLocation = fsLocation;
        this.debug = debug;
    }

    async init(performRegister=false) {
        // mqtt connect; setup delete runtime msg as last will
        const rtMngr = this;
        this.mc = new MQTTClient({
            mqtt_host: rtMngr.mqttHost,
            mqtt_username: rtMngr.mqttUsername,
            mqtt_token: rtMngr.mqttToken,
            onMessageCallback: rtMngr.onMqttMessage.bind(rtMngr),
            willMessage: rtMngr.lastWillStringMsg,
            willMessageTopic: rtMngr.regTopic,
            userid: rtMngr.name,
        });

        await this.mc.connect();

        // subscribe to reg to receive registration confirmation
        this.mc.subscribe(this.regTopic);

        // registration
        this.isRegistered = !performRegister; // TMP: skip registration
        this.register();
        if (!performRegister) this.onRuntimeRegistered();
        ARENA.events.emit(ARENA_EVENTS.RUNTIME_MNGR_LOADED, true);
    }

    /**
     * Register runtime with orchestrator
     */
    register() {
        if (this.isRegistered === true) return;

        if (this.debug === true) console.info('Runtime-Mngr: Registering...');

        const regMsg = this.rtMsgs.registerRuntime();
        this.regRequestUuid = regMsg.object_id; // save message uuid for confirmation

        this.mc.publish(this.regTopic, JSON.stringify(regMsg));

        setTimeout(this.register.bind(this), this.regTimeoutSeconds * 1000); // try register again
    }

    onMqttMessage(message) {
        let msg;
        try {
            msg = JSON.parse(message.payloadString);
        } catch (err) {
            console.error(
                `Runtime-Mngr: Could not parse message: [${message.destinationName}==${+']'}`,
                message.payloadString,
                err
            );
            return;
        }

        if (this.debug === true) console.info('Runtime-Mngr: rcv msg', msg);

        if (this.isRegistered === false) {
            // response from orchestrator
            if (msg.type === RuntimeMsgs.Type.resp) {
                // response to reg request ?
                if (this.regRequestUuid && msg.object_id === this.regRequestUuid) {
                    // check if result was ok
                    if (msg.data.result !== RuntimeMsgs.Result.ok) {
                        console.error(`Error registering runtime:${msg.data}`);
                        return;
                    }
                    // finish up registration
                    this.onRuntimeRegistered();
                }
            }
            // if we are not registered, nothing else to do
        }

        /** *************
         * TODO: process module create/delete requests here
         * from: https://github.com/SilverLineFramework/runtime-browser
         ************** */
    }

    /**
     * Called once the runtime is initialized; create modules requested meantime
     */
    onRuntimeRegistered() {
        this.isRegistered = true;

        console.info("Runtime-Mngr: Registered. %cShift+Opt+P to force program reload", "color: orange"); 

        this.mc.unsubscribe(this.regTopic);
        // subscribe to ctl/runtime_uuid
        this.mc.subscribe(`${this.getRtCtlTopic()}/#`);

        // check if we have modules to start
        if (this.pendingModulesArgs.length > 0) {
            const rtMngr = this;
            this.pendingModulesArgs.forEach((args) => {
                if (rtMngr.debug === true) {
                    console.info('Runtime-Mngr: Starting module', args.persistObj);
                }
                rtMngr.createModuleFromPersist(args.persistObj, args.replaceVars);
            });
        }
        this.pendingModulesArgs = [];

        // signal init is done and ready to roll
        if (this.onInitCallback !== undefined) {
            this.onInitCallback();
        }
    }

    /**
     * Send create module message from persist object
     * @param {object} persistObj - module persist data (See example)
     * @param {object} replaceVars - dictionary of extra variables to replace (e.g. {scene: "ascene"})
     * @example Persisted module example
     *   {
     *     "object_id": "38bffa0e-b3ab-4f5b-854f-b9dc6b52ec0c",
     *     "action": "create",
     *     "persist": true,
     *     "type": "program",
     *     "attributes": {
     *       "name": "arena/py/moving-box",
     *       "instantiate": "client",
     *       "filename": "box.py",
     *       "filetype": "PY",
     *       "env": [
     *         "SCENE=${scene}",
     *         "MQTTH=${mqtth}",
     *         "REALM=realm",
     *         "NAMESPACE=${namespace}"
     *        ],
     *       "channels": []
     *     }
     *   }
     */
    createModuleFromPersist(persistObj, replaceVars = {}) {
        // if runtime is not registered yet, add to pending modules list so they are processed later
        if (!this.isRegistered) {
            this.pendingModulesArgs.push({
                persistObj,
                replaceVars,
            });
            return;
        }

        // instanciate create module message
        const modCreateMsg = this.rtMsgs.createModuleFromPersistObj(persistObj, replaceVars);

        // save this module data to delete before exit
        this.modules.push({"isClientInstantiate": persistObj.attributes.instantiate === 'client', "moduleCreateMsg": modCreateMsg});
        
        // TODO: save pending req uuid and check orchestrator responses
        // NOTE: object_id in runtime messages are used as a transaction id
        // this.pendingReq.push(modCreateMsg.object_id); // pending_req is a list with object_id of requests waiting arts response

        console.info('Sending create module request:', modCreateMsg);
        this.mc.publish(this.ctlTopic, JSON.stringify(modCreateMsg));
    }

    /**
     * Send delete module messages for 'per client' modules; if all==true, sends delete to all modules requested for current scene
     * called on 'before unload' event
     * @param {boolean} all -  sends delete to all modules requested for current scene; default is to onlt delete client instance programs
     */
    cleanup(all=false) {
        console.info(`Runtime-Mngr: Cleanup(all=${all})`, this.modules);        
        this.modules.forEach((saved) => {
            if (saved.isClientInstantiate || all==true) {
                const modDelMsg = this.rtMsgs.deleteModule(saved.moduleCreateMsg.data);
                if (this.debug === true) console.info('Sending delete module request:', modDelMsg);
                this.mc.publish(this.ctlTopic, JSON.stringify(modDelMsg));
            }
        });

        // sent in case last will fails (this will be a duplicate of last will)
        this.mc.publish(this.regTopic, this.lastWillStringMsg);
    }

    /**
     * Requests modules previously loaded in current scene; by default only client instance ones
     * @param {boolean} all - relead all modules requested for current scene; default is to only request client instance programs
     */
    restart(all=false) {
        console.info(`Runtime-Mngr: Restart(all=${all})`, this.modules);        
        this.modules.forEach((saved) => {
            if (saved.isClientInstantiate || all==true) {
                if (this.debug === true) console.info('Sending create module request:', saved.moduleCreateMsg);
                this.mc.publish(this.ctlTopic, JSON.stringify(saved.moduleCreateMsg));
            }
        });
    }

    /**
     * Cleanup all modules in the scene and request them again
     */
    reload(all=false) {
        this.cleanup(all);
        this.restart(all);
    }

    /* public getters */

    getUuid() {
        return this.uuid;
    }

    getName() {
        return this.name;
    }

    getMaxNmodules() {
        return this.maxNmodules;
    }

    getApis() {
        return this.apis;
    }

    getFSLocation() {
        return this.fsLocation;
    }

    getRtDbgTopic() {
        return `${this.dbgTopic}/${this.uuid}`;
    }

    /* pubsub topic where the runtime sends unregister messages (ctl_topic+module uuid) */
    getRtCtlTopic() {
        return `${this.ctlTopic}/${this.uuid}`;
    }
}
