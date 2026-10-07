'use strict'

const http = require('http.min')
const cookie = require("cookie");
const cheerio = require('cheerio');
const { PortalSession } = require('./portal-session')

class FiftyFiveClient {
    /**
     *
     */
    constructor(getCredentials, sessionOptions = {}) {
        this.getCredentials = getCredentials;
        this.session = new PortalSession(sessionOptions);
    } 

    //We store the active token in mem, it gets stale quick anyway
    auth_token = {
        api_cookie: '',
        set_date: new Date(),
        serverid: '',
        cred_url: ''
    }

    async startSession(point, channel, rfid)
    {
        return this.SessionAction(point.idx, channel, 'StartTransaction', rfid, 0)
    }
    async stopSession(point, channel)
    {
        return this.SessionAction(point.idx, channel, 'StopTransaction', '', 0)
    }
    async blockSession(point, channel)
    {
        return this.SessionAction(point.idx, channel, 'Block', '', 0)
    }
    async unblockSession(point, channel)
    {
        return this.SessionAction(point.idx, channel, 'Unblock', '', 0)
    }
    async requestUpdate(point, channel)
    {
        return this.SessionAction(point.idx, '', 'GetStatus', '',1)
    }
    async SessionAction(id, channel, action, printedNumber, button)
    {
        const querystring = require('querystring');
        //Base request structure for actions
        const params = {
            action: action,
            rechargeSpotId: id,
            clickedButtonId: button
        };
        //Add the card and customer field if the card is passed
        if (channel!=='') {
            params.channel = channel
        }
        
        if (printedNumber!=='') {
            //convert the printedNumber in the 50five id
            const cardid = await this.CardAccess(id, printedNumber);
            //console.dir(cardid, { depth: null })
            params.customer = null,
            params.card = cardid.contractId;
        }

        const requestPayload = {
        "0": {
            handler: "\\LMS\\EV\\AsyncServices\\RechargeSpotsAsyncService",
            method: "action",
            params: params
            }
        }
        const requestString = querystring.stringify({
        requests: JSON.stringify(requestPayload),
        metricKey: "RechargeSpotDashboard_1021"
        })

        
        console.log('🔍 Sending action request: '+action);

        return await this.getApiData(requestString)
        .then(result => {
                console.log('✅ 4.1: command accepted: '+action);
                //console.dir(result, { depth: null })
                return result;
        })
        .catch(err => {
            console.error('❌ 4.1: command rejected:', err.message);
            throw err;
        })
    };

    normalizeDateString(dateStr) {
        const monthMap = {
            'jan.': 'Jan', 'feb.': 'Feb', 'mrt.': 'Mar', 'apr.': 'Apr',
            'mei':  'May', 'jun.': 'Jun', 'jul.': 'Jul', 'aug.': 'Aug',
            'sep.': 'Sep', 'okt.': 'Oct', 'nov.': 'Nov', 'dec.': 'Dec'
        };

        // Replace Dutch month with English equivalent
        for (const [dutch, english] of Object.entries(monthMap)) {
            if (dateStr.includes(dutch)) {
            return dateStr.replace(dutch, english);
            }
        }

        return dateStr; // fallback if no match
    }

    async SessionLog(point)
    {
        const querystring = require('querystring');
        //Base request structure for logs
        const params = {
            rechargeSpotId: point.idx,
            channel: point.channel,
            detailed: false,
            id: null,
            extend: false
        };

        const requestPayload = {
        "0": {
            handler: "\\LMS\\EV\\AsyncServices\\RechargeSpotsAsyncService",
            method: "log",
            params: params
            }
        }
        const requestString = querystring.stringify({
        requests: JSON.stringify(requestPayload),
        metricKey: "RechargeSpotDashboard_1431"
        })

        //const token = await getAuthCookie(cred_username, cred_secure_password);
        console.log('🔍 Sending session log request: ');

        return await this.getApiData(requestString)
        .then(result => {
                console.log('✅ 5.1: command accepted: ');

                if (!Array.isArray(result) || !Array.isArray(result[0])) {
                    console.log('⚠️ 5.1: No session log entries returned');
                    return [];
                }

                // Descending Sort by parsed date
                const sortedData = result[0].sort((a, b) => {
                    const dateA = new Date(this.normalizeDateString(a.LOG_DATE));
                    const dateB = new Date(this.normalizeDateString(b.LOG_DATE));
                    return dateB - dateA;
                });
                //console.dir(sortedData, { depth: null })
                const transactionEntries = sortedData.filter(item => item.EVENT_DATA?.startsWith("Transaction")).slice(0,1);
                return sortedData.slice(0,2).concat(transactionEntries);
        })
        .catch(err => {
            console.error('❌ 5.1: command rejected:', err.message);
            return null;
        })
    }

    //Tries to retrieve the cardid from the api using the card number printed on the card
    async CardAccess(idx, printedNumber)
    {
        const querystring = require('querystring');
        //Base request structure for logs
        const params = {
            rechargeSpotId: idx,
            customerId: null,
            input: printedNumber
        };

        const requestPayload = {
        "0": {
            handler: "\\LMS\\EV\\AsyncServices\\RechargeSpotsAsyncService",
            method: "cardAccess",
            params: params
            }
        }
        const requestString = querystring.stringify({
        requests: JSON.stringify(requestPayload),
        metricKey: "RechargeSpotDashboard_1431"
        })

        //const token = await getAuthCookie(cred_username, cred_secure_password);
        console.log('🔍 Sending card access request: '+printedNumber.slice(0, -6).replace(/./g, '*') + printedNumber.slice(-6));

        return await this.getApiData(requestString)
        .then(result => {
                console.log('✅ 6.1: command accepted: ');
                if (Array.isArray(result) && Array.isArray(result[0])) {
                    console.log('✅ 6.2: Located card details:');
                    //console.dir(result[0], { depth: null })
                    return result[0][0];
                } else {
                    console.log('⚠️ 6.2: Unexpected response structure');
                    return null;
            }
        })
        .catch(err => {
            console.error('❌ 6.1: command rejected:', err.message);
            throw err;
        })
    }

    formatDate(date)
    {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-based
        const year = date.getFullYear();

        const formattedDate = `${day}-${month}-${year}`;
        return formattedDate
    }

    async TransactionHistory(startDate, endDate)
    {
        const querystring = require('querystring');

        const requestString = querystring.stringify({
        startDateField: this.formatDate(startDate),
        endDateField: this.formatDate(endDate),
        typeField:"TransactionsOwnSpot",
        employeeField:null,
        cardField:null,
        rechargeSpotField:null,
        invoiceField:null,
        showButton:"Show",
        searchTable_length:500
        })

        const payload = "draw=1&columns%5B0%5D%5Bdata%5D=0&columns%5B0%5D%5Bname%5D=&columns%5B0%5D%5Bsearchable%5D=true&columns%5B0%5D%5Borderable%5D=true&columns%5B0%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B0%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B1%5D%5Bdata%5D=1&columns%5B1%5D%5Bname%5D=&columns%5B1%5D%5Bsearchable%5D=true&columns%5B1%5D%5Borderable%5D=true&columns%5B1%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B1%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B2%5D%5Bdata%5D=2&columns%5B2%5D%5Bname%5D=&columns%5B2%5D%5Bsearchable%5D=true&columns%5B2%5D%5Borderable%5D=true&columns%5B2%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B2%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B3%5D%5Bdata%5D=3&columns%5B3%5D%5Bname%5D=&columns%5B3%5D%5Bsearchable%5D=true&columns%5B3%5D%5Borderable%5D=true&columns%5B3%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B3%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B4%5D%5Bdata%5D=4&columns%5B4%5D%5Bname%5D=&columns%5B4%5D%5Bsearchable%5D=true&columns%5B4%5D%5Borderable%5D=true&columns%5B4%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B4%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B5%5D%5Bdata%5D=5&columns%5B5%5D%5Bname%5D=&columns%5B5%5D%5Bsearchable%5D=true&columns%5B5%5D%5Borderable%5D=true&columns%5B5%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B5%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B6%5D%5Bdata%5D=6&columns%5B6%5D%5Bname%5D=&columns%5B6%5D%5Bsearchable%5D=true&columns%5B6%5D%5Borderable%5D=true&columns%5B6%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B6%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B7%5D%5Bdata%5D=7&columns%5B7%5D%5Bname%5D=&columns%5B7%5D%5Bsearchable%5D=true&columns%5B7%5D%5Borderable%5D=true&columns%5B7%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B7%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B8%5D%5Bdata%5D=8&columns%5B8%5D%5Bname%5D=&columns%5B8%5D%5Bsearchable%5D=true&columns%5B8%5D%5Borderable%5D=true&columns%5B8%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B8%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B9%5D%5Bdata%5D=9&columns%5B9%5D%5Bname%5D=&columns%5B9%5D%5Bsearchable%5D=true&columns%5B9%5D%5Borderable%5D=true&columns%5B9%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B9%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B10%5D%5Bdata%5D=10&columns%5B10%5D%5Bname%5D=&columns%5B10%5D%5Bsearchable%5D=true&columns%5B10%5D%5Borderable%5D=true&columns%5B10%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B10%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B11%5D%5Bdata%5D=11&columns%5B11%5D%5Bname%5D=&columns%5B11%5D%5Bsearchable%5D=true&columns%5B11%5D%5Borderable%5D=true&columns%5B11%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B11%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B12%5D%5Bdata%5D=12&columns%5B12%5D%5Bname%5D=&columns%5B12%5D%5Bsearchable%5D=true&columns%5B12%5D%5Borderable%5D=true&columns%5B12%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B12%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B13%5D%5Bdata%5D=13&columns%5B13%5D%5Bname%5D=&columns%5B13%5D%5Bsearchable%5D=true&columns%5B13%5D%5Borderable%5D=true&columns%5B13%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B13%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B14%5D%5Bdata%5D=14&columns%5B14%5D%5Bname%5D=&columns%5B14%5D%5Bsearchable%5D=true&columns%5B14%5D%5Borderable%5D=true&columns%5B14%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B14%5D%5Bsearch%5D%5Bregex%5D=false&order%5B0%5D%5Bcolumn%5D=0&order%5B0%5D%5Bdir%5D=desc&start=0&length=500&search%5Bvalue%5D=&search%5Bregex%5D=false"

        //const token = await getAuthCookie(cred_username, cred_secure_password);
        console.log('🔍 Sending TransactionLog request: ');

        return await this.postApiData(requestString, "/Transactions/List/json", payload)
        .then(result => {
                console.log('✅ 7.1: command accepted: ');
                if (result && result.data) {
                    console.log('✅ 7.2: Transaction history:');
                    //console.dir(result.data, { depth: null })
                    return result.data;
                } else {
                    console.log('⚠️ 7.2: Unexpected response structure');
                    return null;
            }
        })
        .catch(err => {
            console.error('❌ 7.1: command rejected:', err.message);
            throw err;
        })
    }

    async getAuthCookie() {
        await this.session.ensure(this.getCredentials().cred_url);
        const cookies = this.session.jar.getCookiesSync(this.session.origin);
        this.auth_token = {
            api_cookie: cookies.find(c => c.key === 'PHPSESSID')?.value || '',
            serverid: cookies.find(c => c.key === 'SERVERID')?.value || '',
            cred_url: this.session.origin
        };
        return this.auth_token.api_cookie;
    }

    async cards(){
        return await this.getMyChargeCards();
    }

    //This is now based on html parsing, not a very reliable method.
    async getMyChargeCards()
    {
        await this.getAuthCookie();
        const html = await this.session.request('GET', '/Cards/List', undefined, false);
        //Lets parse the html and collect the card references
        const $ = cheerio.load(html);

        const tokens = $('#GenId1 tbody tr').toArray().map(row => {
            //console.log(row);
            const $row = $(row);
            const rfidText = $row.find('td').eq(0).text().trim();
            //console.log(rfidText);
            const printedNumber = rfidText.split(' ').pop().trim();

            const reference = $row.find('td').eq(2).find('span.card-reference').text().trim();
            //console.log(reference);

            return {
                rfid: printedNumber.slice(0, -6).replace(/./g, '*') + printedNumber.slice(-6),
                printedNumber: printedNumber,
                name: reference
            }
        });

        
        const maskedTokens = tokens.map(token => ({
        ...token,
        printedNumber: token.rfid
        }));


        console.dir(maskedTokens, { depth: null });
        return tokens
    }

    async postApiData(endpointQuery, endpoint = '/api/ajax', payload) {
        await this.getAuthCookie();
        return this.session.request('POST', `${endpoint}?${endpointQuery.replace(/^\?/, '')}`, payload);
    }

    async getApiData(endpointQuery, endpoint = '/api/ajax') {
        await this.getAuthCookie();
        return this.session.request('GET', `${endpoint}?${endpointQuery.replace(/^\?/, '')}`);
    }

    async getSinglePointByIDX(idx){
        console.log('🔍 1.0: Get all chargepoints to filter on the idx ['+idx+']');
        const myPoints = await this.getMyChargePoints();    
        if(myPoints==null || !Array.isArray(myPoints) || myPoints.length === 0) {
            console.log('⚠️ 1.1: No chargepoints found in your account, can also mean there are no new details');
            return null;
        }
        console.log('✅ 1.1: Collected my ChargePoints and their details');
        //console.dir(myPoints, { depth: null });
        console.log('🔍 1.2: Now match on the idx ['+idx+']');
        const match = myPoints.find(item => item.idx === idx);
        if (match) {
            console.log('✅ 1.3: Found matching chargepoint:', match.idx);
            return match;
        } else {
            console.log('⚠️ 1.3: No chargepoint found with that idx');
            return null;
        }
    }

    async getSinglePointBySerial(serial){
        console.log('🔍 1.0: Get all chargepoints to filter on the serial ['+serial+']');
        const myPoints = await this.getMyChargePoints();    
        if(myPoints==null || !Array.isArray(myPoints) || myPoints.length === 0) {
            console.log('⚠️ 1.1: No chargepoints found in your account, can also mean there are no new details');
            return null;
        }
        console.log('✅ 1.1: Collected my ChargePoints and their details');
        //console.dir(myPoints, { depth: null });
        console.log('🔍 1.2: Now match on the serial ['+serial+']');
        const match = myPoints.find(item => item.serial === serial);
        if (match) {
            console.log('✅ 1.3: Found matching chargepoint:', match.serial);
            return match;
        } else {
            console.log('⚠️ 1.3: No chargepoint found with that serial');
            return null;
        }
    }

    async getSinglePoint(id) {
        const encodedQuery = `requests=%7B"0"%3A%7B"handler"%3A"%5C%5CLMS%5C%5CEV%5C%5CAsyncServices%5C%5CRechargeSpotsAsyncService"%2C"method"%3A"overview"%2C"params"%3A%7B"rechargeSpotId"%3A"${id}"%7D%7D%7D&metricKey=RechargeSpotDashboard_149`;
        console.log('🔍 3.0: Attempt to retrieve chargepoint status');
        return await this.getApiData(encodedQuery)
        .then(result => {
            if (Array.isArray(result) && Array.isArray(result[0])) {
                console.log('✅ 3.1: Located chargepoint status');
                const point = result[0][0];
                console.log('✅ 3.2: Data received from Chargepoint status API:');
                console.log(`🔌 CONNECTOR: ${point.CONNECTOR}`);
                console.log(`   Cardid: ${point.CARDID}`);
                console.log(`   Status: ${point.STATUS}`);
                console.log(`   Notification: ${point.NOTIFICATION}`);
                //console.dir(result[0], { depth: null });
                return point;
            } else {
                console.warn('⚠️ 3.2: Unexpected response structure');
                return null;
            }
        })
        .catch(err => {
            console.error('❌ 3.1: Failed to fetch chargepoint overview:', err.message);
            return null;
        })
    }

    async list(){
        return await this.getMyChargePoints();
    }

    async getMyChargePoints()
    {  
        console.log('🔍 2.0: Get all chargepoints from the account');
        let chargePoints = await (async () => {
        try {
            const result = await this.getApiData("requests=%7B%220%22%3A%7B%22handler%22%3A%22%5C%5CLMS%5C%5CEV%5C%5CAsyncServices%5C%5CDashboardAsyncService%22%2C%22method%22%3A%22networkOverview%22%2C%22params%22%3A%7B%22mode%22%3A%22id%22%7D%7D%7D&metricKey=EndUserRechargeSpotListView_99");
            console.log('✅ 2.1: Data received from Chargepoint list API:');
            console.dir(result, { depth: null });
            // The response contains a double array nesting
            // not seen any results that has more than one (the real array) elements in the first level
            if (Array.isArray(result) && Array.isArray(result[0])) {
                console.log('✅ 2.2: Located chargepoints:');
                return result[0];
            } else if (Array.isArray(result) && result.length === 0) {
                //An empty response is a valid answer: this account simply has no chargepoints
                console.log('⚠️ 2.2: The account returned no chargepoints');
                return [];
            } else {
                console.log('⚠️ 2.2: Unexpected response structure');
                return null;
            }
        } catch (error) {
            console.error('❌ 2.2: Request failed:', error.response?.status);
            console.error('🧾 2.2: Response:', error.response?.data || error.message);
            return null;
        }
        })();
        if(chargePoints==null)
            return null;
        // 🔍 construct the base 50five point data
        console.log('✅ 2.3: All charge point collected, return structure');
        let promises = chargePoints.map((point) => {
            console.log(`🔌 IDX: ${point.IDX}`);
            console.log(`   Name: ${point.NAME}`);
            console.log(`   Address: ${point.ADDRESS}`);
            console.log(`   Channel: ${point.CHANNEL}`);
            const shell_id_raw = point.ADDRESS?.split(',')[0]?.trim();
            const shell_id = /^[0-9A-Za-z]+$/.test(shell_id_raw) ? shell_id_raw : null;
            console.log(`   Recharge IDX: ${shell_id}`);  
            const result = {
                serial: shell_id,
                idx: point.IDX,
                name: point.NAME,
                channel: point.CHANNEL
            };
            console.log('✅ 2.4: Located chargepoint with serial '+result.serial);
            console.dir(result, { depth: null });
            return result;
        });
        return (await Promise.all(promises)).filter(cp => cp !== null);
    }

    async pointDetails(point){
        return await this.getMyChargePointDetails(point);
    }

    async getMyChargePointDetails(point)
    {  
        // 🔍 Attempt to parse into details per chargepoint
        console.log('🔍 4.0: Get chargepoint status details with idx: '+point.idx);

        var pointdetails = this.getSinglePoint(point.idx).then(cp => {
            if(cp==null) return null;
            cp.serial = point.serial;
            cp.idx = point.idx;
            cp.name = point.name;
            cp.channel = point.channel;
            console.log('✅ 2.5: Located chargepoint status for ['+cp.name+']');
            //console.dir(cp, { depth: null });
            return cp;
        },
        err => {
            console.log('❌ 2.5: Retrieving single point ['+point.name+'],'+err);
            return null;
        });
        return pointdetails;
    }
}

module.exports.ChargePointService = FiftyFiveClient;