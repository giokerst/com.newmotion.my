'use strict';

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const FormData = require('form-data');

class AuthError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
const needsAuth = () => new AuthError('AUTH_REQUIRED', 'Open Repair and sign in to 50five again.');
// Fixed stage labels and numeric status only: never expose cookies, codes or portal HTML.
const authFailure = (stage, response) => new AuthError('AUTH_REQUIRED',
    `50five login could not be completed [${stage}${response ? `; HTTP ${response.status}` : ''}]. Return to login to request a new code.`);

// One cookie jar per account. Login/OTP use a separate instance until verified.
class PortalSession {
    constructor({ load, save, onExpired, transport } = {}) {
        this.load = load || (async () => null);
        this.save = save || (async () => {});
        this.onExpired = onExpired || (async () => {});
        this.transport = transport || (config => axios.request(config));
        this.jar = new CookieJar();
        this.state = 'new';
        this.origin = null;
        this.token = null;
        this.otpForm = null;
        this.initializing = null;
        this.queue = Promise.resolve();
    }

    static origin(value) {
        const url = new URL(value || 'https://50five-snl.evc-net.com');
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
            throw new AuthError('INVALID_URL', 'Use the HTTPS address of your 50five portal, without a path.');
        }
        return url.origin;
    }

    export() { return { origin: this.origin, cookies: this.jar.serializeSync() }; }

    async restore(data, origin) {
        this.origin = PortalSession.origin(origin);
        this.token = null;
        this.jar = new CookieJar();
        this.state = 'required';
        if (data && data.origin === this.origin) {
            try {
                this.jar = CookieJar.deserializeSync(data.cookies);
                if (this.hasCookie()) this.state = 'restored';
            } catch (_) { this.jar = new CookieJar(); }
        }
    }

    hasCookie() {
        return !!this.origin && this.jar.getCookiesSync(this.origin).some(c => c.key === 'PHPSESSID');
    }

    async expire(error = needsAuth()) {
        this.token = null;
        this.jar = new CookieJar();
        if (this.state !== 'required') {
            this.state = 'required';
            await this.save(null);
            await this.onExpired();
        }
        throw error;
    }

    redirect(location) {
        const url = new URL(location, this.origin);
        // Some LMS deployments return an http Location even on HTTPS pages.
        if (url.protocol === 'http:' && url.hostname === new URL(this.origin).hostname && !url.port) url.protocol = 'https:';
        if (url.origin !== this.origin || url.username || url.password) {
            throw new AuthError('UNEXPECTED_REDIRECT', 'The portal redirected to a different server.');
        }
        return url.pathname + url.search;
    }

    isChallenge(response) {
        return /\/2fa(?:[/?_]|$)/i.test(response.headers.location || '') ||
            /name\s*=\s*["']_auth_code["']/i.test(String(response.data));
    }

    isLogin(response) {
        return /\/Login(?:[/?]|$)/i.test(response.headers.location || '') ||
            /name\s*=\s*["'](?:emailField|passwordField)["']/i.test(String(response.data));
    }

    async raw(method, path, data, headers = {}) {
        const url = new URL(path, this.origin);
        if (url.origin !== this.origin) throw new Error('Cross-origin request rejected');
        let response;
        try {
            response = await this.transport({
                url: url.href, method, data, timeout: 20000, maxRedirects: 0,
                responseType: 'text', transformResponse: [value => value],
                validateStatus: () => true,
                headers: { Accept: '*/*', Cookie: this.jar.getCookieStringSync(url.href), ...headers }
            });
        } catch (_) {
            // Axios errors contain request headers and bodies: never propagate them.
            throw new Error('Cannot reach the 50five portal. Please try again later.');
        }
        const cookies = response.headers['set-cookie'] || [];
        for (const value of typeof cookies === 'string' ? [cookies] : cookies) this.jar.setCookieSync(value, url.href);
        if (response.status === 429 || response.status >= 500) throw new Error('50five is temporarily unavailable. Please try again later.');
        if (this.state === 'authenticated') await this.save(this.export());
        return response;
    }

    async form(path, fields) {
        const data = new FormData();
        for (const [name, value] of Object.entries(fields)) data.append(name, String(value));
        return this.raw('POST', path, data, { ...data.getHeaders(), Origin: this.origin, Referer: this.origin + (path === '/2fa_check' ? '/2fa' : '/Login/Login') });
    }

    async challenge() {
        const response = await this.raw('GET', '/2fa');
        if ([302, 303].includes(response.status) && response.headers.location) {
            this.redirect(response.headers.location);
            if (this.isLogin(response)) throw authFailure('OTP_FORM_LOGIN', response);
            if (this.isChallenge(response)) throw authFailure('OTP_REDIRECT_LOOP', response);
            // Landing pages vary by deployment. Confirm using the fixed read API.
            return this.validate(true, false);
        }
        if (response.status !== 200 || response.headers.location) throw authFailure('OTP_FORM', response);
        const $ = cheerio.load(String(response.data));
        const form = $('input[name="_auth_code"]').closest('form');
        this.token = form.find('input[name="_token"]').val();
        if (!this.token || !form.length) throw new Error('The portal returned an unsupported verification form.');
        if (form.attr('method') && form.attr('method').toLowerCase() !== 'post') throw new Error('The portal returned an unsupported verification method.');
        const fields = {};
        form.find('input[type="hidden"][name]:not([disabled])').each((_, el) => {
            fields[$(el).attr('name')] = $(el).val() || '';
        });
        const submit = form.find('input[type="submit"][name], button[type="submit"][name], button:not([type])[name]').first();
        if (submit.length) fields[submit.attr('name')] = submit.attr('value') || '';
        else fields.VerifyOtp = 'Verify';
        this.otpForm = {
            path: this.redirect(form.attr('action') || '/2fa_check'),
            multipart: (form.attr('enctype') || '').toLowerCase() === 'multipart/form-data',
            fields
        };
        this.state = 'otp';
        return { status: 'otp_required' };
    }

    async login(origin, username, password) {
        this.origin = PortalSession.origin(origin);
        this.jar = new CookieJar();
        this.state = 'login';
        this.token = null;
        const page = await this.raw('GET', '/Login/Login');
        if (page.status !== 200) throw new Error('Cannot open the 50five login page.');
        const $ = cheerio.load(String(page.data));
        const fields = {};
        $('form input[type="hidden"][name]').each((_, el) => { fields[$(el).attr('name')] = $(el).val() || ''; });
        fields.emailField = username;
        fields.passwordField = password;
        fields.Login = $('[name="Login"]').val() || $('[name="Login"]').text().trim() || 'Log in';
        const response = await this.form('/Login/Login', fields);
        if (this.isChallenge(response)) return this.challenge();
        if (![302, 303].includes(response.status) || !response.headers.location || this.isLogin(response)) {
            throw new AuthError('INVALID_LOGIN', 'Login failed. Check your username and password.');
        }
        this.redirect(response.headers.location);
        return this.validate(true);
    }

    async verify(code) {
        if (this.state !== 'otp' || !this.token) throw authFailure('OTP_SESSION');
        if (!/^[0-9]{6}$/.test(code)) throw new AuthError('INVALID_OTP', 'Enter the six-digit code from your email.');
        const fields = { ...(this.otpForm ? this.otpForm.fields : { VerifyOtp: 'Verify' }), _token: this.token, _auth_code: code };
        const path = this.otpForm ? this.otpForm.path : '/2fa_check';
        const response = this.otpForm && !this.otpForm.multipart
            ? await this.raw('POST', path, new URLSearchParams(fields).toString(), {
                'Content-Type': 'application/x-www-form-urlencoded', Origin: this.origin, Referer: this.origin + '/2fa'
            })
            : await this.form(path, fields);
        if ([302, 303].includes(response.status) && response.headers.location) {
            this.redirect(response.headers.location);
            if (this.isLogin(response)) throw authFailure('OTP_SUBMIT_LOGIN', response);
            if (!this.isChallenge(response)) {
                const result = await this.validate(true);
                if (result.status === 'authenticated') { this.token = null; return result; }
            }
        } else if (![200, 400, 403, 422].includes(response.status)) {
            throw new Error('Unexpected verification response from 50five.');
        }
        const result = await this.challenge();
        if (result.status === 'authenticated') { this.token = null; return result; }
        throw new AuthError('INVALID_OTP', 'The code was rejected or expired. Try again or request a new code.');
    }

    async validate(interactive = false, allowChallenge = true) {
        let path = '/Overview';
        for (let i = 0; i < 4; i++) {
            const response = await this.raw('GET', path);
            if (this.isChallenge(response)) {
                if (interactive && !allowChallenge) throw authFailure('OTP_REDIRECT_LOOP', response);
                return interactive ? this.challenge() : this.expire();
            }
            if (this.isLogin(response) || [401, 403].includes(response.status)) return this.expire(interactive ? authFailure('DASHBOARD_LOGIN', response) : needsAuth());
            if (response.status >= 300 && response.status < 400 && response.headers.location) {
                path = this.redirect(response.headers.location);
                // Never visit an arbitrary redirect target: it could perform an action.
                const pathname = new URL(path, this.origin).pathname.replace(/\/$/, '') || '/';
                if (!['/', '/Overview'].includes(pathname)) return this.validateApi(interactive, allowChallenge);
                continue;
            }
            if (response.status !== 200 || !String(response.data).trim()) throw authFailure('DASHBOARD_RESPONSE', response);
            return this.validateApi(interactive, allowChallenge);
        }
        throw new Error('Too many portal redirects.');
    }

    async validateApi(interactive, allowChallenge) {
        if (!this.hasCookie()) throw authFailure('SESSION_COOKIE');
        // A pre-authentication cookie is not proof of a completed login.
        const data = new URLSearchParams({ requests: JSON.stringify({ '0': {
            handler: '\\LMS\\EV\\AsyncServices\\DashboardAsyncService', method: 'networkOverview', params: { mode: 'id' }
        } }), metricKey: 'EndUserRechargeSpotListView_99' }).toString();
        // Match getMyChargePoints(): LMS receives the read request in the query string.
        const api = await this.raw('GET', '/api/ajax?' + data);
        if (this.isChallenge(api)) {
            if (interactive && !allowChallenge) throw authFailure('OTP_REDIRECT_LOOP', api);
            return interactive ? this.challenge() : this.expire();
        }
        if (this.isLogin(api) || [401, 403].includes(api.status)) return this.expire(interactive ? authFailure('API_LOGIN', api) : needsAuth());
        let result;
        try { result = JSON.parse(api.data); } catch (_) { throw authFailure('API_NOT_JSON', api); }
        if (api.status !== 200 || !Array.isArray(result) || !Array.isArray(result[0])) throw authFailure('API_RESPONSE', api);
        this.state = 'authenticated';
        await this.save(this.export());
        return { status: 'authenticated' };
    }

    async ensure(origin) {
        origin = PortalSession.origin(origin);
        if (this.initializing) await this.initializing;
        if (this.state === 'new') {
            if (!this.initializing) this.initializing = (async () => {
                await this.restore(await this.load(), origin);
                if (this.state === 'restored') await this.validate();
                else { this.state = 'new'; await this.expire(); }
            })().finally(() => { this.initializing = null; });
            await this.initializing;
        }
        if (this.origin !== origin || this.state === 'required' || !this.hasCookie()) return this.expire();
        if (this.state === 'restored') await this.validate();
        if (this.state !== 'authenticated') throw needsAuth();
    }

    request(method, path, data, json = true) {
        const result = this.queue.then(() => this.authenticatedRequest(method, path, data, json));
        this.queue = result.catch(() => {});
        return result;
    }

    async authenticatedRequest(method, path, data, json = true) {
        await this.ensure(this.origin);
        let response = await this.raw(method, path, data, data ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {});
        if (this.isLogin(response) || this.isChallenge(response) || [401, 403].includes(response.status)) return this.expire();
        // Never replay a command after an ambiguous response or authentication expiry.
        if (response.status !== 200) throw new Error('Unexpected response from the 50five portal.');
        if (!json) return response.data;
        let result;
        try { result = JSON.parse(response.data); } catch (_) {
            await this.validate();
            throw new Error('50five returned an invalid data response.');
        }
        // LMS can return empty JSON for an expired session instead of redirecting.
        if (Array.isArray(result) && (!result.length || (Array.isArray(result[0]) && !result[0].length))) await this.validate();
        return result;
    }
}

module.exports = { PortalSession, AuthError };
