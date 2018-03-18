/*
 * Copyright (c) 2016, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as bunyan from 'bunyan-sfdx-no-dtrace';
import * as _ from 'lodash';
import { Mode, Global } from './global';
import { SfdxUtil } from './util';
import { SfdxError } from './sfdxError';

export class Bunyan extends bunyan {
    constructor(options: LoggerOptions, _childOptions?: LoggerOptions, _childSimple?: boolean) {
        super(options, _childOptions, _childSimple);
    }
    public level(lvl?: string | number) { return super.level(lvl); }
    public addStream(stream, defaultLevel?: string | number) { return super.addStream(stream, defaultLevel); }
    public levels(name: string | number, value: string | number) { return super.levels(name, value); }
    public child(name: string, fields: any = {}) {
        if (!name) {
            throw new SfdxError('LoggerNameRequired');
        }
        fields.log = name;

        // only support including additional fields on log line (no config)
        return super.child(fields, true);
    }
    public trace(...args: any[]) { return super.trace(...args); }
    public debug(...args: any[]) { return super.debug(...args); }
    public info(...args: any[]) { return super.info(...args); }
    public warn(...args: any[]) { return super.warn(...args); }
    public error(...args: any[]) { return super.error(...args); }
    public fatal(...args: any[]) { return super.fatal(...args); }
}

export interface LoggerStream {
    // tslint:disable-next-line no-reserved-keywords
    type: string;
    level?: string;
    path?: string;
    stream?: any;
    closeOnExit?: boolean;
}

export interface LoggerOptions {
    name: string;
    level?: string;
    serializers?: object;
    src?: boolean;
    stream?: any;
    streams?: LoggerStream[];
}

export enum LoggerLevel {
    TRACE = 10,
    DEBUG = 20,
    INFO = 30,
    WARN = 40,
    ERROR = 50,
    FATAL = 60
}

const SFDX_LOGGER_NAME = 'sfdx';
const DEFAULT_LOG_LEVEL = LoggerLevel.WARN;

// Ok to log clientid
const FILTERED_KEYS = [
    'sid',
    // Any json attribute that contains the words "access" and "token" will have the attribute/value hidden
    { name: 'access_token', regex: 'access[^\'"]*token' },
    // Any json attribute that contains the words "refresh" and "token" will have the attribute/value hidden
    { name: 'refresh_token', regex: 'refresh[^\'"]*token' },
    'clientsecret',
    // Any json attribute that contains the words "sfdx", "auth", and "url" will have the attribute/value hidden
    { name: 'sfdxauthurl', regex: 'sfdx[^\'"]*auth[^\'"]*url' }
];

// Registry of loggers for reuse and to properly close streams
const loggerRegistry: Map<string, Logger> = new Map<string, Logger>();

// close streams
// FIXME: sadly, this does not work when process.exit is called; for now, disabled process.exit
const closeStreams = (fn) => {
    _.invokeMap(loggerRegistry, 'close', fn);
};

const uncaughtExceptionHandler = (err) => {
    // log the exception
    if (loggerRegistry.has(SFDX_LOGGER_NAME)) {
        // FIXME: good chance this won't be logged because
        // process.exit was called before this is logged
        // https://github.com/trentm/node-bunyan/issues/95
        loggerRegistry.get(SFDX_LOGGER_NAME).fatal(err);
    }
};

// SFDX code and plugins should never show tokens or connect app information in the logs
const _filter = (...args) => args.map((arg) => {
    if (_.isArray(arg)) {
        return _filter(...arg);
    }

    if (arg) {
        let _arg = arg;

        // Normalize all objects into a string. This include errors.
        if (_.isObject(arg)) {
            _arg = JSON.stringify(arg);
        }

        const HIDDEN = 'HIDDEN';

        FILTERED_KEYS.forEach((key: any) => {

            let expElement = key;
            let expName = key;

            // Filtered keys can be strings or objects containing regular expression components.
            if (_.isPlainObject(key)) {
                expElement = key.regex;
                expName = key.name;
            }

            const hiddenAttrMessage = `"<${expName} - ${HIDDEN}>"`;

            // Match all json attribute values case insensitive: ex. {" Access*^&(*()^* Token " : " 45143075913458901348905 \n\t" ...}
            const regexTokens = new RegExp(`(['"][^'"]*${expElement}[^'"]*['"]\\s*:\\s*)['"][^'"]*['"]`, 'gi');
            _arg = _arg.replace(regexTokens, `$1${hiddenAttrMessage}`);

            // Match all key value attribute case insensitive: ex. {" key\t"    : ' access_token  ' , " value " : "  dsafgasr431 " ....}
            const keyRegex = new RegExp(`(['"]\\s*key\\s*['"]\\s*:)\\s*['"]\\s*${expElement}\\s*['"]\\s*.\\s*['"]\\s*value\\s*['"]\\s*:\\s*['"]\\s*[^'"]*['"]`, 'gi');
            _arg = _arg.replace(keyRegex, `$1${hiddenAttrMessage}`);
        });

        // This is a jsforce message we are masking. This can be removed after the following pull request is committed
        // and pushed to a jsforce release.
        //
        // Looking  For: "Refreshed access token = ..."
        // Related Jsforce pull requests:
        //  https://github.com/jsforce/jsforce/pull/598
        //  https://github.com/jsforce/jsforce/pull/608
        //  https://github.com/jsforce/jsforce/pull/609
        const jsForceTokenRefreshRegEx = new RegExp('Refreshed(.*)access(.*)token(.*)=\\s*[^\'"\\s*]*');
        _arg = _arg.replace(jsForceTokenRefreshRegEx, `<refresh_token - ${HIDDEN}>`);

        _arg = _arg.replace(/sid=(.*)/, `sid=<${HIDDEN}>`);

        // return an object if an object was logged; otherwise return the filtered string.
        return _.isObject(arg) ? JSON.parse(_arg) : _arg;
    } else {
        return arg;
    }

});

/**
 * Logger class for logging to sfdx.log based on the bunyan implementation.
 * Register and create a new logger:
 * @example Logger.create('myLogger').init();
 * @extends Bunyan
 * @see https://github.com/cwallsfdc/node-bunyan
 */
export class Logger extends Bunyan {
    public static commandName: string;

    /**
     * Create/get the root logger with the default log level and file stream.
     */
    public static async root(): Promise<Logger> {
        let logger;
        try {
            logger = Logger.get();
        } catch (e) {
            logger = Logger.create().setLevel();
            // disable log file writing, if applicable
            if (process.env.SFDX_DISABLE_LOG_FILE !== 'true' && (Global.getEnvironmentMode() !== Mode.TEST)) {
                await logger.addLogFileStream(Global.LOG_FILE_PATH);
            }
        }
        return logger;
    }

    /**
     * Create a child of the root logger, inheriting log level, streams, etc.
     * @param name The name of the child logger.
     * @param fields Additional fields included in all log lines.
     */
    public static async child(name: string, fields?: any): Promise<Logger> {
        return (await Logger.root()).child(name, fields);
    }

    /**
     * Register, create and return a named instance of a logger.
     *
     * @param name The name of the logger to create.  Defaults to the SFDX core logger.
     * @returns Logger The Logger instance.
     */
    public static create(name: string = SFDX_LOGGER_NAME): Logger {
        // Return it if already registered
        if (loggerRegistry.has(name)) {
            return loggerRegistry.get(name);
        }

        // Create the logger
        const logger = new Logger({
            name,
            level: 'error',
            serializers: bunyan.stdSerializers,
            // No streams for now, not until it is enabled
            streams: []
        });

        // All SFDX loggers must filter sensitive data
        logger.addFilter((...args) => _filter(...args));

        // Register the new logger
        loggerRegistry.set(name, logger);

        logger.trace(`Created and registered '${name}' logger instance`);

        return logger;
    }

    /**
     * Get a registered logger instance.
     *
     * @param name Returns the registered logger instance.
     */
    // tslint:disable-next-line no-reserved-keywords
    public static get(name: string = SFDX_LOGGER_NAME) {
        if (!loggerRegistry.has(name)) {
            throw new Error(`Logger ${name} not found`);
        }

        return loggerRegistry.get(name);
    }

    private _name: string;
    private filters: Array<(...args) => any[]> = [];
    private fields: any = {};
    private ringbuffer: bunyan.RingBuffer;
    private streams: LoggerStream[];

    constructor(options: LoggerOptions, _childOptions?: LoggerOptions, _childSimple?: boolean) {
        super(options, _childOptions, _childSimple);
        this._name = options.name;
    }

    /**
     * Adds a file stream to this logger.
     *
     * @param logFile The path to the log file.  If it doesn't exist it will be created.
     */
    public async addLogFileStream(logFile): Promise<any> {
        try {
            // Check if we have write access to the log file (i.e., we created it already)
            await SfdxUtil.access(logFile, fs.constants.W_OK);
        } catch (err1) {
            try {
                await SfdxUtil.mkdirp(path.dirname(logFile), { mode: SfdxUtil.DEFAULT_USER_DIR_MODE });
            } catch (err2) {
                // noop; directory exists already
            }
            try {
                await SfdxUtil.writeFile(logFile, '', { mode: SfdxUtil.DEFAULT_USER_FILE_MODE });
            } catch (err3) {
                throw SfdxError.wrap(err3);
            }
        }

        // avoid multiple streams to same log file
        if (!this.streams.find((stream) => stream.type === 'file' && stream.path === logFile)) {
            // TODO: rotating-file
            // https://github.com/trentm/node-bunyan#stream-type-rotating-file

            this.addStream({ type: 'file', path: logFile, level : this.level() });
        }

        // to debug 'Possible EventEmitter memory leak detected', add the following to top of index.js or, for
        // log tests, top of this file.
        // https://git.soma.salesforce.com/ALMSourceDrivenDev/force-com-toolbelt/compare/cwall/logs-for-EventEmitter-memory-leak

        // ensure that uncaughtException is logged
        process.on('uncaughtException', uncaughtExceptionHandler);

        // FIXME: ensure that streams are flushed on exit
        // https://github.com/trentm/node-bunyan/issues/37
        process.on('exit', closeStreams);

        return Promise.resolve();
    }

    /**
     * Get the name of this logger.
     */
    get name(): string {
        return this._name;
    }

    /**
     * Compares the requested log level with the current log level.  Returns true if
     * the requested log level is greater than or equal to the current log level.
     *
     * @param logLevel The requested log level to compare against the currently set log level
     * @returns {boolean}
     */
    public shouldLog(logLevel: number): boolean {
        return logLevel >= this.level();
    }

    /**
     * Use in-memory logging for this logger instance instead of any parent streams. Useful for testing.
     *
     * WARNING: This cannot be undone for this logger instance.
     */
    public useMemoryLogging(): Logger {
        this.streams = [];
        this.ringbuffer = new bunyan.RingBuffer({ limit: 5000 });
        this.addStream({ type: 'raw', stream: this.ringbuffer, level: this.level() });
        return this;
    }

    /**
     * Returns an array of log line objects. Each element is an object that corresponds to a log line.
     *
     * @returns {Array<string>}
     */
    public getBufferedRecords(): string[] {
        return this.ringbuffer.records;
    }

    /**
     * Returns a text blob of all the log lines contained in memory or the log file.
     *
     * @returns {string}
     */
    public readLogContentsAsText(): string {
        if (this.ringbuffer) {
            return this.getBufferedRecords().reduce((accum, value) => {
                accum += (JSON.stringify(value) + os.EOL);
                return accum;
            }, '');
        } else {
            let content = '';

            this.streams.forEach(async (stream) => {
                if (stream.type === 'file') {
                    content += await SfdxUtil.readFile(stream.path, 'utf8');
                }
            });
            return content;
        }
    }

    /**
     * Adds a filter to be applied on all logging.
     *
     * @param filter - function defined in a command constructor
     * that manipulates log messages
     */
    public addFilter(filter: (...args) => any[]) {
        this.filters.push(filter);
    }

    /**
     * When logging messages to the default log file, this method
     * calls the filters defined in the executed commands.
     *
     * @param logLevel The log level.  Filtering will only be applied for relevant log levels.
     * @param args An array of strings, objects, etc.
     */
    public applyFilters(logLevel, ...args) {
        if (this.shouldLog(logLevel)) {
            this.filters.forEach((filter) => {
                args = filter(...args);
            });
        }
        return args && args.length === 1 ? args[0] : args ;
    }

    /**
     * Close the logger, including any streams, and remove all listeners.
     *
     * @param {function} fn A function to call for each stream with the stream as an arg.
     */
    public close(fn?: (stream: LoggerStream) => void) {
        if (this.streams) {
            try {
                this.streams.forEach((stream) => {
                    if (fn && _.isFunction(fn)) {
                        fn(stream);
                    }

                    // close stream, flush buffer to disk
                    if (stream.type === 'file') {
                        stream.stream.end();
                    }
                });
            } finally {
                // remove listeners to avoid 'Possible EventEmitter memory leak detected'
                process.removeListener('uncaughtException', uncaughtExceptionHandler);
                process.removeListener('exit', closeStreams);
            }
        }
    }

    /**
     * Create a child logger, typically to add a few log record fields.
     *
     * @see bunyan.child(options, simple).
     *
     * @param {string} name The name of the child logger that is emitted w/ logline as log:<name>
     * @param {object} fields Additional fields included in all log lines for the child logger.
     * @returns {logger}
     */
    public child(name: string, fields: any = {}): Logger {
        // only support including additional fields on log line (no config)
        const childLogger = super.child(name, fields);

        childLogger._name = name;
        childLogger.filters = this.filters;

        // store to close on exit
        loggerRegistry.set(name, childLogger);

        this.trace(`Setup '${name}' logger instance`);

        return childLogger;
    }

    /**
     * Add a field to all log lines for this logger
     *
     * @param name The name of the field to add.
     * @param value The value of the field to be logged.
     * @returns {logger}
     */
    public addField(name: string, value: string | number | boolean): Logger {
        this.fields[name] = value;
        return this;
    }

    public isDebugEnabled(): boolean {
        return super.debug();
    }

    public isError() {
        return this.level() === LoggerLevel.ERROR;
    }

    /**
     * Set the logging level of all streams for this logger.
     * @param level The logger level.
     * @see LoggerLevel enum for values.
     */
    public setLevel(level?: LoggerLevel | number | string): Logger {
        const defaultLogLevel = process.env.SFDX_LOG_LEVEL || DEFAULT_LOG_LEVEL;
        level = _.isNil(level) ? defaultLogLevel : level;
        try {
            this.level(level);
        } catch (err) {
            throw SfdxError.wrap(err);
        }
        return this;
    }

    public trace(...args) {
        return super.trace(this.applyFilters(LoggerLevel.TRACE, ...args));
    }

    public debug(...args) {
        return super.debug(this.applyFilters(LoggerLevel.DEBUG, ...args));
    }

    public info(...args) {
        return super.info(this.applyFilters(LoggerLevel.INFO, ...args));
    }

    public warn(...args) {
        return super.warn(this.applyFilters(LoggerLevel.WARN, ...args));
    }

    public error(...args) {
        return super.error(this.applyFilters(LoggerLevel.ERROR, ...args));
    }

    public fatal(...args) {
        // Always show fatal to stderr
        console.error(...args); // eslint-disable-line no-console
        return super.fatal(this.applyFilters(LoggerLevel.FATAL, ...args));
    }
}
