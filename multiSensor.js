module.exports = function(RED) {
    var STATUS_INACTIVE = {id:0,name:"inactive"};
    var STATUS_ACTIVE = {id:1,name:"active"};
    var STATUS_ACTIVATING = {id:2,name:"activating"};
    var STATUS_DEACTIVATING = {id:3,name:"deactivating"};
    var STATUS_CANCEL_ACT = {id:130,name:"abortActivation"};
    var STATUS_CANCEL_DEACT = {id:131,name:"abortDeactivation"};

    function SensorNode(config) {
        RED.nodes.createNode(this,config);
        var node = this;

        if (config.activateDelayUnit === "milliseconds") this.activeDelay = config.activateDelay;
        else if (config.activateDelayUnit === "minutes") this.activeDelay = config.activateDelay * (60 * 1000);
        else if (config.activateDelayUnit === "hours")   this.activeDelay = config.activateDelay * (60 * 60 * 1000);
        else if (config.activateDelayUnit === "days")    this.activeDelay = config.activateDelay * (24 * 60 * 60 * 1000);
        else this.activeDelay = config.activateDelay * 1000;

        if (config.inactivateDelayUnit === "milliseconds") this.inactiveDelay = config.inactivateDelay;
        else if (config.inactivateDelayUnit === "minutes") this.inactiveDelay = config.inactivateDelay * (60 * 1000);
        else if (config.inactivateDelayUnit === "hours")   this.inactiveDelay = config.inactivateDelay * (60 * 60 * 1000);
        else if (config.inactivateDelayUnit === "days")    this.inactiveDelay = config.inactivateDelay * (24 * 60 * 60 * 1000);
        else this.inactiveDelay = config.inactivateDelay * 1000;
        
        node.activeTimer = -1;
        node.inactiveTimer = -1;

        var active = false;
        var sensors = [];
        var customStatus;
        var origMsg;

        function get(id, noCreate) {
            var s = sensors.find(function(s) { return s.id==id; });
            if (!s && !noCreate) {
                s = {id:id, active:false};
                sensors.push(s);
            }
            return s;
        }

        function countActive() {
            var c = 0;
            for (var i=sensors.length-1; i>=0; i--)
                if (sensors[i].active) c++;
            return c;
        }

        function abortActive() {
            if (node.activeTimer==-1) return;
            clearInterval(node.activeTimer);
            node.activeTimer = -1;
            state(STATUS_CANCEL_ACT);
        }

        function abortInactive() {
            if (node.inactiveTimer==-1) return;
            clearInterval(node.inactiveTimer);
            node.inactiveTimer = -1;
            state(STATUS_CANCEL_DEACT);
        }

        function sendOnActive(msg) {
            // Abort any inactive timer
            abortInactive();

            // If already active, then
            if (active)
                return;
            
            var activeDelay = Number.isInteger(msg.activeDelay) ? msg.activeDelay : node.activeDelay;

            if (activeDelay == 0) {
                doSend(msg, true);
            } else {
                state(STATUS_ACTIVATING);
                if (node.activeTimer==-1) {
                    node.activeTimer = setTimeout(function() {
                        node.activeTimer = -1;
                        // If not already been customly activated, then send activate
                        if (!active)
                            doSend(msg, true);
                        
                    }, activeDelay);
                }
            }
        }

        function sendOnInactive(msg) {
            // Abort any active timer
            abortActive();

            // If already inactive, then
            if (!active)
                return;

            var inactiveDelay = Number.isInteger(msg.inactiveDelay) ? msg.inactiveDelay : node.inactiveDelay;
        
            if (inactiveDelay == 0) {
                doSend(msg, false);
            } else {
                state(STATUS_DEACTIVATING);
                if (node.inactiveTimer==-1) {
                    node.inactiveTimer = setTimeout(function() {
                        node.inactiveTimer = -1;
                        
                        // If not already been customly deactivated, then send deactivate
                        if (active)
                            doSend(msg, false);
                        
                    }, inactiveDelay);
                }
            }
        }

        function state(id, skipSend) {
            if (!skipSend)
                node.send(config.seperated ? [undefined,undefined,id] : [undefined,id]);
            return id;
        }

        function getData(value, type, msg) {
            switch (type) {
                case "pay":     return origMsg;
                case "payl":    return msg;
                case "nul":     return undefined;
                default:        return RED.util.evaluateNodeProperty(value, type, node, msg);
            }
        }

        function doSend(msg, isActive) {
            active = isActive;
            updateStatus();

            if (isActive) {
                if (config.sendOnActiveType == "nul") return;
                msg = getData(config.sendOnActive, config.sendOnActiveType, msg);
            } else {
                if (config.sendOnInactiveType == "nul") return;
                msg = getData(config.sendOnInactive, config.sendOnInactiveType, msg);
            }

            if (config.seperated == true) {
                node.send([isActive?msg:undefined, isActive?undefined:msg, state(isActive?STATUS_ACTIVE:STATUS_INACTIVE, true)]);
            }
            else
                node.send([msg, state(isActive?STATUS_ACTIVE:STATUS_INACTIVE, true)]);
        }

        function updateStatus() {
            try {
                if (customStatus==undefined) {
                    var c = active?"green":"red";
                    if (node.activeTimer!=-1 || node.inactiveTimer!=-1)
                        c = "yellow";
                    node.status({fill:c,shape:"dot",text:countActive() + " of " + sensors.length + " sensors active."});
                } else
                    node.status(customStatus);
            } catch(e) {
            node.warn("Invalid msg.status!");
            }
        }

        node.on('input', function(msg) {
            var id = RED.util.evaluateNodeProperty(config.idField, config.idType, node, msg);
            var inputValue = RED.util.evaluateNodeProperty(config.inputValue, config.inputType, node, msg);
            var activeValue = RED.util.evaluateNodeProperty(config.activeValue, config.activeType, node, msg);
            var inactiveValue = RED.util.evaluateNodeProperty(config.inactiveValue, config.inactiveType, node, msg);
            
            if (inputValue == activeValue) {
                var s = get(id);
                var a = countActive();
                // If same state, then do nothing
                if (s.active)
                    return;
                
                s.active = true;
                // If first active, then
                if (a==0) {
                    origMsg = msg;
                    sendOnActive(msg);
                }
                
            } else if (inputValue == inactiveValue) {
                var s = get(id, true);

                // If same state, then do nothing
                if (!s || !s.active)
                    return;
                
                s.active = false;
                // If nothing active anymore
                if (countActive()==0)
                    sendOnInactive(msg);

            } else {
                node.debug('Neither active nor inactive');
            }

            customStatus = msg.status;
            updateStatus();
        });

        updateStatus();
    }
    RED.nodes.registerType("multiSensor",SensorNode);
};