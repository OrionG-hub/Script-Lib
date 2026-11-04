import { HttpError, reply } from './common.js';
import { raw } from './raw.js';
import { webhook } from './bot.js';

export default {
    async fetch(request, env, ctx) {
        try {
            return await (new URL(request.url).pathname === '/webhook' ? webhook(request, env) : raw(request, env, ctx));
        } catch (error) {
            if (error instanceof HttpError) return reply(error.message, error.status);
            // Do not log request URLs, upstream URLs, or error bodies containing tokens.
            console.error('Unhandled Worker error.');
            return reply('Internal Server Error.', 500);
        }
    }
};
