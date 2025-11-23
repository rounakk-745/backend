let requestContext = {};

export const logger = {
    setContext(context) {
        requestContext = { ...requestContext, ...context };
    },

    clearContext() {
        requestContext = {};
    },

    info(message, meta = {}) {
        console.log(JSON.stringify({
            level: 'INFO',
            message,
            timestamp: new Date().toISOString(),
            ...requestContext,
            ...meta,
        }));
    },

    warn(message, meta = {}) {
        console.log(JSON.stringify({
            level: 'WARN',
            message,
            timestamp: new Date().toISOString(),
            ...requestContext,
            ...meta,
        }));
    },

    error(message, meta = {}) {
        console.log(JSON.stringify({
            level: 'ERROR',
            message,
            timestamp: new Date().toISOString(),
            ...requestContext,
            ...meta,
        }));
    },

    logRequest(method, path, statusCode, meta = {}) {
        this.info('Request completed', {
            method,
            path,
            statusCode,
            ...meta,
        });
    },
};