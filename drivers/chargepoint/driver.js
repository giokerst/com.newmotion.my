'use strict'

const Homey = require('homey')
const MNM = require('../../lib/50five')
const CP = require('./chargepoint')
const HomeyCrypt = require('../../lib/homeycrypt')
const { PortalSession } = require('../../lib/portal-session')

function mobile() {
    return
}

class ChargepointDriver extends Homey.Driver {

    onInit() {
        this.sessionOptions = {
            load: async () => {
                const value = this.homey.settings.get('portal_session');
                if (!value) return null;
                try { return JSON.parse(await HomeyCrypt.decrypt(value, this.getCredentials().cred_username)); }
                catch (_) { return null; }
            },
            save: async (data, source) => {
                if (source !== this.chargepointService.session) return;
                const value = data ? await HomeyCrypt.crypt(JSON.stringify(data), this.getCredentials().cred_username) : null;
                if (source === this.chargepointService.session) this.homey.settings.set('portal_session', value);
            },
            onExpired: async source => {
                if (source !== this.chargepointService.session) return;
                if (this.homey.settings.get('portal_auth_notice')) return;
                this.homey.settings.set('portal_auth_notice', true);
                await this.homey.notifications.createNotification({ excerpt: this.homey.__('auth.repair_notice') })
                    .catch(() => this.error('Could not create authentication notification'));
            }
        };
        this.chargepointService = new MNM.ChargePointService(this.getCredentials, this.sessionOptions);
        this.attachSession(this.chargepointService.session);

        this._flowTriggerSessionStart = this.homey.flow.getDeviceTriggerCard('sessionstart').registerRunListener(async ( args, state ) => {
			return true;
		  });
        this._flowTriggerChargeCompleted = this.homey.flow.getDeviceTriggerCard('chargecompleted').registerRunListener(async ( args, state ) => {
			return true;
		  });
        this._flowTriggerChargingStarted = this.homey.flow.getDeviceTriggerCard('chargingstarted').registerRunListener(async ( args, state ) => {
			return true;
		  });
        this._flowTriggerSessionStop = this.homey.flow.getDeviceTriggerCard('sessionstop').registerRunListener(async ( args, state ) => {
			return true;
		  });
        this._flowTriggerChanged = this.homey.flow.getDeviceTriggerCard('changed').registerRunListener(async ( args, state ) => {
			return true;
		  });
        this._flowTriggerOccupied = this.homey.flow.getDeviceTriggerCard('occupied').registerRunListener(async ( args, state ) => {
			return true;
		  });
        this._flowTriggerOffline = this.homey.flow.getDeviceTriggerCard('offline').registerRunListener(async ( args, state ) => {
			return true;
		  });
        this._flowTriggerFree = this.homey.flow.getDeviceTriggerCard('free').registerRunListener(async ( args, state ) => {
			return true;
		  });
        //Deprecated triggers
        this._flowTriggerStart = this.homey.flow.getDeviceTriggerCard('start').registerRunListener(async ( args, state ) => {
			return true;
		  });
        this._flowTriggerCompleted = this.homey.flow.getDeviceTriggerCard('charge_completed').registerRunListener(async ( args, state ) => {
			return true;
		  });
        this._flowTriggerStop = this.homey.flow.getDeviceTriggerCard('stop').registerRunListener(async ( args, state ) => {
			return true;
		  });
        this._flowTriggerCharging = this.homey.flow.getDeviceTriggerCard('charging').registerRunListener(async ( args, state ) => {
			return true;
		  });  
    }

    getCredentials = () => {
        var cred_username = this.homey.settings.get('user_email');
        var cred_secure_password = this.homey.settings.get('user_password');
        var cred_url = this.homey.settings.get('user_url');

        if(!cred_url){
            cred_url = 'https://50five-snl.evc-net.com';
        }

        return {
            cred_username,
            cred_secure_password,
            cred_url
        }
    };

    attachSession(client) {
        client.load = this.sessionOptions.load;
        client.save = data => this.sessionOptions.save(data, client);
        client.onExpired = () => this.sessionOptions.onExpired(client);
        this.chargepointService.session = client;
    }

    registerAuthentication(session) {
        let pending = null;
        let busy = false;
        const finish = async () => {
            const { client, username, encryptedPassword, origin } = pending;
            const encryptedSession = await HomeyCrypt.crypt(JSON.stringify(client.export()), username);
            // Publish credentials and the verified session only after both factors succeed.
            this.homey.settings.set('user_email', username);
            this.homey.settings.set('user_password', encryptedPassword);
            this.homey.settings.set('user_url', origin);
            this.homey.settings.set('portal_session', encryptedSession);
            this.homey.settings.set('portal_auth_notice', false);
            this.attachSession(client);
            pending = null;
            return { status: 'authenticated' };
        };
        const guarded = handler => async data => {
            if (busy) throw new Error(this.homey.__('auth.busy'));
            busy = true;
            try { return await handler(data); }
            finally { busy = false; }
        };
        session.setHandler('testlogin', guarded(async data => {
            pending = null;
            const username = String(data.username || '').trim();
            if (!username || typeof data.password !== 'string' || !data.password) throw new Error(this.homey.__('auth.missing_credentials'));
            const origin = PortalSession.origin(data.url);
            const client = new PortalSession();
            const encryptedPassword = await HomeyCrypt.crypt(data.password, username);
            const result = await client.login(origin, username, data.password);
            pending = { client, username, encryptedPassword, origin };
            return result.status === 'authenticated' ? finish() : result;
        }));
        session.setHandler('verifyotp', guarded(async data => {
            if (!pending) throw new Error(this.homey.__('auth.restart'));
            const result = await pending.client.verify(String(data.code || '').trim());
            return result.status === 'authenticated' ? finish() : result;
        }));
        session.setHandler('disconnect', async () => { pending = null; });
    }

   async onRepair(session, device) {
        // Argument session is a PairSocket, similar to Driver.onPair
        // Argument device is a Homey.Device that's being repaired
    
        session.setHandler("showView", async (data) => {
            console.log('Login page of repair is showing, send credentials');
            //Send the stored credentials to the 
            var username = this.homey.settings.get('user_email');
            var cryptedpassword = this.homey.settings.get('user_password');            
            var cred_url = this.homey.settings.get('user_url');

            try {
                const plainpass = await HomeyCrypt.decrypt(cryptedpassword,username);
                session.emit('loadaccount', {'username': username,'password': plainpass, 'url': cred_url});
            } catch (err) {
                session.emit('loadaccount', {'username': username,'password': '', 'url': cred_url})
            }
        });

        this.registerAuthentication(session);
    
      }

   async onPair(session) {
        let mydevices;

        session.setHandler('showView', async (viewId)=>{
            //These actions send data to the custom views
            
            if(viewId === 'login') {
                console.log('Login page of pairing is showing, send credentials');
                //Send the stored credentials to the 
                var username = this.homey.settings.get('user_email');
                var cryptedpassword = this.homey.settings.get('user_password');
                var cred_url = this.homey.settings.get('user_url');

                try {
                    const plainpass = await HomeyCrypt.decrypt(cryptedpassword,username);
                    session.emit('loadaccount', {'username': username,'password': plainpass, 'url': cred_url});
                } catch (err) {
                    session.emit('loadaccount', {'username': username,'password': '', 'url': cred_url})
                }
            };
            if(viewId === 'device_settings') {
                console.log('Allow the user to select card');
                this.chargepointService.cards().then(function (cards) {
                    const mycards = cards.map((card) => {
                        return card;
                    });
                    return session.emit('loadcards', mycards);
                }).catch(() => session.showView('login'));
            };
        });

        this.registerAuthentication(session);


        session.setHandler('discover_chargepoints', async ( data ) => {
            console.log('Now find all our chargepoints from my account');
            session.showView('discover_chargepoints');
            try{
                this.chargepointService.list()
                    .then(function (points) {
                        if (points === null) {
                            console.log('Could not retrieve the chargepoint list from the account');
                            mydevices = [];
                            session.showView('error');
                            return;
                        }
                        if (points.length === 0) {
                            //A valid but empty account, let the user pick from an empty list instead of an error
                            console.log('The account contains no chargepoints');
                            mydevices = [];
                            session.showView('list_devices');
                            return;
                        }
                        //A charge point that we could not get details for might be returned as null
                        const devices = points.filter(function(device) {
                            if (device === null) {
                              return false; // skip
                            }
                            return true;
                          }).map((point) => {
                            try{
                                console.log('Located a device response, lets convert it into a cp');
                                var enhancedpoint = CP.enhance(point);
                                console.log('Now setup a basic device for ['+enhancedpoint.name+']');
                                let devicedev = {
                                    name: enhancedpoint.name,
                                    data: { idx: enhancedpoint.idx, serial: enhancedpoint.serial },
                                    store: { cache: enhancedpoint },
                                    mobile: mobile()
                                }
                                try{
                                    console.log('building cp ['+enhancedpoint.name+']');
                                    var device=CP.buildDevice(devicedev, enhancedpoint);
                                    console.log('device built:'+device.name)
                                    return device;
                                }catch(err){
                                    console.log(err);
                                    return err;
                                }
                            }catch(err){
                                console.log(err);
                                return err;
                            }
                        })
                        console.log('back with my devices:'+devices.length);
                        //So we are done here, let the user choose
                        //console.log(JSON.stringify(devices));
                        mydevices=devices;
                        session.showView('list_devices');
                    })
                    .catch((err) => { console.log('Get chargepoints, '+err); session.showView('error');})
                
                .catch((err) => { console.log('Get token, '+err); session.showView('error');})
            }catch(err){
                console.log('Generic error:'+err);
                session.showView('error');
            }
        });

        session.setHandler('list_devices', async (data) => {
            console.log('Provide user list of chargepoints to choose from.');
            return mydevices;
        });
          
        session.setHandler('add_devices', async (data) => {
            session.showView('add_devices');
            if(data.length>0)
                console.log('chargepoint ['+data[0].name+'] added');
            else
                console.log('no chargepoint added');
      	});

 
    }

    triggerSessionStart(device, tokens, state) {
        console.log('Car connected trigger')
        this._flowTriggerSessionStart
            .trigger(device, tokens, state)
            .then(this.log)
            .catch(this.error)
    }

    triggerSessionStop(device, tokens, state) {
        console.log('Car disconnected trigger')
        this._flowTriggerSessionStop
            .trigger(device, tokens, state)
            .then(this.log)
            .catch(this.error)
    }

    triggerChargeCompleted(device, tokens, state) {
        console.log('Completed session trigger')
        this._flowTriggerChargeCompleted
            .trigger(device, tokens, state)
            .then(this.log)
            .catch(this.error)
    }

    triggerChanged(device, tokens, state) {
        console.log('State changed trigger')
        this._flowTriggerChanged
            .trigger(device, tokens, state)
            .then(this.log)
            .catch(this.error)
    }

    triggerOccupied(device) {
        console.log('Charger occupied trigger')
        this._flowTriggerOccupied
            .trigger(device, {}, {})
            .then(this.log)
            .catch(this.error)
    }

    triggerOffline(device) {
        console.log('Charger offline trigger')
        this._flowTriggerOffline
            .trigger(device, {}, {})
            .then(this.log)
            .catch(this.error)
    }

    triggerChargingStarted(device, tokens, state){
        console.log('Start charging trigger')
        this._flowTriggerChargingStarted
            .trigger(device, tokens, state)
            .then(this.log)
            .catch(this.error)
    }

    triggerFree(device) {
        console.log('Charger is free trigger')
        this._flowTriggerFree
            .trigger(device, {}, {})
            .then(this.log)
            .catch(this.error)
    }

    //Deprecated ones
    triggerStart(device, tokens, state) {
        console.log('Car connected trigger')
        this._flowTriggerStart
            .trigger(device, tokens, state)
            .then(this.log)
            .catch(this.error)
    }

    triggerStop(device, tokens, state) {
        console.log('Car disconnected trigger')
        this._flowTriggerStop
            .trigger(device, tokens, state)
            .then(this.log)
            .catch(this.error)
    }

    triggerCompleted(device, tokens, state) {
        console.log('Completed session trigger')
        this._flowTriggerCompleted
            .trigger(device, tokens, state)
            .then(this.log)
            .catch(this.error)
    }

    triggerCharging(device, tokens, state){
        console.log('Start charging trigger')
        this._flowTriggerCharging
            .trigger(device, tokens, state)
            .then(this.log)
            .catch(this.error)
    }


}

module.exports = ChargepointDriver