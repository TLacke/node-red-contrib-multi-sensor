module.exports = function(RED) {
    var STATUS_INACTIVE = {id:0,name:"inactive"};
    var STATUS_ACTIVE = {id:1,name:"active"};
    var STATUS_ACTIVATING = {id:2,name:"activating"};
    var STATUS_DEACTIVATING = {id:3,name:"deactivating"};
    var STATUS_SENSOR = {id:32,name:"sensor"};
    var STATUS_TIMEOUT = {id:65,name:"timeout"};
    var STATUS_RESET = {id:66,name:"reset"};
    var STATUS_CANCEL_ACT = {id:130,name:"abortActivation"};
    var STATUS_CANCEL_DEACT = {id:131,name:"abortDeactivation"};

    function getTime(v,t) {
        if (v==undefined || t==undefined) return 0;

        if (t === "milliseconds") return v;
        else if (t === "minutes") return v * (60 * 1000);
        else if (t === "hours")   return v * (60 * 60 * 1000);
        else if (t === "days")    return v * (24 * 60 * 60 * 1000);
        else return v * 1000;
    }

    function SensorNode(config) {
        RED.nodes.createNode(this,config);
        var node = this;

        var tActive = getTime(config.activateDelay, config.activateDelayUnit);
        var tInactive = getTime(config.inactivateDelay, config.inactivateDelayUnit);
        var tSensor = getTime(config.sTimeout, config.sTimeoutUnit);
        var tMain = getTime(config.aTimeout, config.aTimeoutUnit);

        // v=value, t=type
        const S_NORMAL = {v: config.sendOnInactive, t: config.sendOnInactiveType};
        const S_TIMEOUT = {v: config.sendOnTimeout, t: config.sendOnTimeoutType};
        // t=Timeout, d=Direct, s=Status, v:Value data
        const DA_NORMAL = {t:false,d:false, s:STATUS_INACTIVE, v:S_NORMAL};
        const DA_TIMEOUT = {t:true,d:false, s:STATUS_TIMEOUT, v:S_TIMEOUT};
        const DA_TIMEOUT_SENSOR = {t:true,d:false,s:STATUS_TIMEOUT, v:S_TIMEOUT};
        const DA_RESET = {t:false,d:false,s:STATUS_RESET, v:S_NORMAL};
        const DA_RESET_HARD = {t:false,d:true,s:STATUS_RESET, v:S_NORMAL};

        var sensors = [];

        var customStatus;
        var orgMsg,latMsg;

        var txtStatus = " " + RED._("status");

        function d() {
            //console.log.apply(null, arguments);
        }

        var main = {
            a: false,       // isActive
            activate: function() {
                d('Try activate...');
                if (!aSensor())                         // If no active sensor, abort
                    return;
                else if (config.useCount)               // If presenting sensor count changes, then
                    state(STATUS_SENSOR);
                
                if (this.cDeactivate()) return;         // If deactivation cancelled, abort
                if (this.a) return;                     // If already active, abort

                d('Activating...');
                if (tActive>0) {                        // If time to activate
                    if (this.hActive)                   // If already lazy active
                        return;                         // then, Abort
                    
                    d('Timeout to active ' + tActive);
                    orgMsg = latMsg;                    // Update org message before timer to get first.
                    this.hActive = setTimeout(()=>this.onActivate(), tActive); // Set timeout
                    state(STATUS_ACTIVATING);
                } else {
                    orgMsg = latMsg;                    // Update original message to activation message
                    this.onActivate();                  // Otherwise, just activate
                }
            },
            onActivate: function() {
                d('Activated');
                this.hActive = undefined;               // Reset lazy active timer
                this.a = true;                          // Set to active
                
                var msg = getData(config.sendOnActive, config.sendOnActiveType);
                state(STATUS_ACTIVE, msg);

                sensors.forEach(s=>s.updTimeout());

                if (tMain>0) {                          // If has main timeout, then set it up
                    d('Main timeout: ' + tMain);
                    this.hMain = setTimeout(()=>this.onTimeout(), tMain);
                }
            },
            cActivate: function() {
                d('Try cancel activation');
                if (this.hActive) {
                    d('Cancel activation');
                    clearTimeout(this.hActive);
                    this.hActive = undefined;
                    state(STATUS_CANCEL_ACT);
                    return true;
                }
                return false;
            },
            deactivate: function(st) {
                d('Try deactivate...');
                if (aSensor()) {                        // If has active sensor, abort
                    if (config.useCount)                // If presenting sensor count changes, then
                        state(STATUS_SENSOR);
                    
                    return;
                }
                if (this.cActivate()) return;           // Cancel any activation, abort
                if (!this.a) return;                    // If not active, abort
                
                if (st===undefined)
                    st = DA_NORMAL;

                d('Deactivate...');
                if (!st.d && tInactive>0) {             // If not direct and has time to deactivate
                    if (this.hInactive)                 // If not active
                        return;                         // Abort
                    
                    d('Timeout to deactivate ' + tInactive);
                    this.hInactive = setTimeout(()=>this.onDeactivate(st), tInactive); // Set timeout
                    state(STATUS_DEACTIVATING);
                } else
                    this.onDeactivate(st);              // Otherwise, just deactivate
            },
            onDeactivate: function(st) {
                d('Deactivated');
                this.hInactive = undefined;             // Reset lazy inactive timer
                this.a = false;                         // set to inactive
                
                clearTimeout(this.hMain);               // Remove any main timeout
                this.hMain = undefined;

                state(st.s, getData(st.v.v, st.v.t));   // Setting state to specified and attaching correct out data
            },
            cDeactivate: function() {
                d('Try cancel deactivation');
                if (this.hInactive) {
                    d('Cancel deactivation');
                    clearTimeout(this.hInactive);
                    this.hInactive = undefined;

                    clearTimeout(this.hMain);
                    this.hMain = undefined;
                    if (tMain>0)                        // If has main timeout
                        this.hMain = setTimeout(()=>this.onTimeout(), tMain); // Reset timeout

                    state(STATUS_CANCEL_DEACT);
                    return true;
                }
                return false;
            },
            onTimeout: function(st) {
                d('Main timeout occurred...');
                if (!this.a) {                          // If active
                    d('Not active, try cancel activation.');
                    this.cActivate();
                }
                
                if (st === undefined)
                    st=DA_TIMEOUT;
                
                sensors.forEach(s=>s.deactivate(st));
            }
        };

        function get(id, create) {
            var s = sensors.find(function(s) { return s.id==id; }); // Find sensor
            if (!s && create===true) {  // If no sensor found and allow create
                s = {id:id,
                    a:false,
                    activate: function() {
                        d('Try activate sensor ' + this.id);

                        if (this.a) {               // If already active
                            this.updTimeout();
                            
                            d('Sensor already active');
                            return;                 // abort
                        }

                        d('Sensor activated.');
                        this.a=true;                // Set to active
                        main.activate();            // Try activate main
                        
                        this.updTimeout();
                        updateStatus();
                    },
                    deactivate: function(st) {
                        d('Try deactivate sensor ' + this.id);
                        if (!this.a) {              // If not active
                            d('Already inactive.');
                            return;                 // abort
                        }
                        
                        d('Sensor deactivated.');
                        this.a=false;               // Set to inactive
                        this.updTimeout();          // Clear any timeout (after deact)
                        main.deactivate(st);        // Try deactivate main
                        updateStatus();
                    },
                    updTimeout: function() {
                        d('Resetting sensor timeout ' + tSensor);
                        clearTimeout(this.ht);
                        this.ht=undefined;

                        if (tSensor > 0) {          // If sensor timeout specified
                            if (this.a && main.a) { // Must be active (Sensor and main)
                                d('Assign sensor timeout');
                                this.ht=setTimeout(()=>this.timeOut(), tSensor);
                            }
                        }
                    },
                    timeOut: function() {
                        d('Sensor '+this.id+' timed out.');
                        this.deactivate(DA_TIMEOUT_SENSOR); // Deactivate on timeout
                    }
                };
                sensors.push(s);
            }
            return s;
        }

        function aSensor() {
            return !!sensors.find(s=>s.a);
        }

        function cSensor() {
            var c=0;
            sensors.forEach(s=>s.a && c++);
            return c;
        }

        function state(id, msg) {
            id = Object.assign({},id);
            
            if (config.useCount) {
                id.active=cSensor();
                id.total=sensors.length;
            }
            
            if (config.seperated) {
                var ia = id==STATUS_ACTIVE;
                d('sending seperated message for:',id, msg?'with message':'no message');
                node.send([ia?msg:undefined , ia?undefined:msg , id]);
            } else {
                d('sending bundled message for:',id, msg?'with message':'no message');
                node.send([msg,id]);
            }
            
            updateStatus();
        }

        function getData(value, type) {
            d('Getting data:', value, '(type=', type, ')');
            switch (type) {
                case "payl":    return latMsg;
                case "pay":     return orgMsg;
                case "nul":     return undefined;
                default:        return RED.util.evaluateNodeProperty(value, type, node, latMsg);
            }
        }

        function updateStatus() {
            try {
                d('Updating status');
                if (customStatus==undefined) {
                    var c = main.a?"green":"red";
                    if (main.hActive || main.hInactive)
                        c = "yellow";
                    node.status({fill:c,shape:"dot",text:cSensor() + " / " + sensors.length + txtStatus});
                } else {
                    d('Custom status active.');
                    node.status(customStatus);
                }
            } catch(e) {
                node.warn("Invalid msg.status!");
            }
        }

        node.on('input', function(msg) {
            latMsg = msg;

            var id = RED.util.evaluateNodeProperty(config.idField, config.idType, node, msg);
            var inputValue = RED.util.evaluateNodeProperty(config.inputValue, config.inputType, node, msg);
            var activeValue = RED.util.evaluateNodeProperty(config.activeValue, config.activeType, node, msg);
            var inactiveValue = RED.util.evaluateNodeProperty(config.inactiveValue, config.inactiveType, node, msg);
            
            customStatus = msg.status;

            if (msg.reset!==undefined && msg.reset!=false) {
                main.onTimeout((msg.reset=='hard')?DA_RESET_HARD:DA_RESET);
                
            } else if (inputValue == activeValue) {
                get(id, true).activate();
                
            } else if (inputValue == inactiveValue) {
                var s = get(id, false);
                if (s) s.deactivate();

            } else {
                node.debug('Neither active nor inactive');
            }

            if (customStatus)
                updateStatus();
        });

        this.on("close", function() {
            main.onTimeout(DA_RESET_HARD); // Directly close everything down.
        });

        updateStatus();
    }
    RED.nodes.registerType("multiSensor",SensorNode);
};