/*
 * Copyright 2018 the original author or authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const waitForPort = util.promisify(require('wait-for-port'));
const { FunctionInvokerClient, MessageBuilder, MessageHeaders } = require('@projectriff/function-proto');
const grpc = require('grpc');

const HOST = process.env.HOST || '127.0.0.1';
let port = 60061;

const serverPath = path.join(__dirname, '..', 'server.js');

describe('server', () => {
    function createServerProcess(functionName, stdio = 'ignore') {
        return childProcess.spawn('node', [serverPath], {
            env: Object.assign({}, process.env, {
                HOST,
                GRPC_PORT: ++port,
                FUNCTION_URI: path.join(__dirname, 'support', `${functionName}.js`)
            }),
            stdio
        });
    }

    async function waitForServer() {
        await waitForPort(HOST, port);
    }

    function requestReplyCall(request) {
        return new Promise(resolve => {
            const client = new FunctionInvokerClient(`${HOST}:${port}`, grpc.credentials.createInsecure());
            const call = client.call();
            call.on('data', message => {
                resolve({
                    headers: MessageHeaders.fromObject(message.headers),
                    payload: message.payload
                });
                call.end();
            });
            call.write(request instanceof MessageBuilder ? request.build() : request);
        });
    }

    it('runs the echo function', async () => {
        const server = createServerProcess('echo-request-reply');

        const exitCode = new Promise(resolve => {
            server.on('exit', resolve);
        });

        await waitForServer();

        const { payload, headers } = await requestReplyCall(
            new MessageBuilder()
                .addHeader('Content-Type', 'text/plain')
                .addHeader('Accept', 'text/plain')
                .payload('riff')
                .build()
        );
        expect(headers.getValue('Error')).toBeNull();
        expect(headers.getValue('Content-Type')).toEqual('text/plain');
        expect(payload.toString()).toEqual('riff');

        server.kill('SIGINT');
        expect(await exitCode).toBe(0);
    });

    it('runs the echo-node-streams function', async () => {
        const server = createServerProcess('echo-node-streams');

        const exitCode = new Promise(resolve => {
            server.on('exit', resolve);
        });

        await waitForServer();

        // listening for GRPC
        await new Promise(resolve => {
            const client = new FunctionInvokerClient(`${HOST}:${port}`, grpc.credentials.createInsecure());
            const data = [1, 2, 3];

            const call = client.call();
            const onData = jasmine.createSpy('onData');
            const onEnd = () => {
                expect(onData).toHaveBeenCalledTimes(3);
                data.forEach((d, i) => {
                    const message = onData.calls.argsFor(i)[0];
                    const headers = MessageHeaders.fromObject(message.headers);
                    expect(headers.getValue('Content-Type')).toEqual('text/plain');
                    expect(message.payload.toString()).toEqual(`riff ${d}`);
                });

                resolve();
            };
            call.on('data', onData);
            call.on('end', onEnd);
            data.forEach(d => {
                call.write(
                    new MessageBuilder()
                        .addHeader('Content-Type', 'text/plain')
                        .payload(`riff ${d}`)
                        .build()
                );
            });
            call.end();
        });

        server.kill('SIGINT');
        expect(await exitCode).toBe(0);
    });

    it('runs the lifecycle function', async () => {
        const server = createServerProcess('lifecycle');

        const exitCode = new Promise(resolve => {
            server.on('exit', resolve);
        });

        await waitForServer();

        const { payload, headers } = await requestReplyCall(
            new MessageBuilder()
                .addHeader('Content-Type', 'text/plain')
                .addHeader('Accept', 'application/json')
                .payload('riff')
                .build()
        );
        expect(headers.getValue('Error')).toBeNull();
        expect(headers.getValue('Content-Type')).toEqual('application/json');

        const { file, content } = JSON.parse(payload.toString());
        expect(await util.promisify(fs.readFile)(file, { encoding: 'utf8' })).toBe(content);

        server.kill('SIGINT');
        expect(await exitCode).toBe(0);

        try {
            await util.promisify(fs.stat)(file);
            fail('Nonce file not deleted by $destroy mehod');
        } catch (e) {
            // expect file to not exist
            expect(e.code).toBe('ENOENT');
        }
    });

    it('kills the init-throws function', async () => {
        const server = createServerProcess('init-throws');

        const exitCode = new Promise(resolve => {
            server.on('exit', resolve);
        });

        expect(await exitCode).toBe(2);
    });

    it('kills the init-timeout function after 10 seconds', async () => {
        const server = createServerProcess('init-timeout');

        const exitCode = new Promise(resolve => {
            server.on('exit', resolve);
        });

        expect(await exitCode).toBe(1);
    }, 15e3);

    it('kills the destroy-throws function', async () => {
        const server = createServerProcess('destroy-throws');

        const exitCode = new Promise(resolve => {
            server.on('exit', resolve);
        });

        await waitForServer();

        server.kill('SIGINT');
        expect(await exitCode).toBe(2);
    });

    it('kills the destroy-timeout function after 10 seconds', async () => {
        const server = createServerProcess('destroy-timeout');

        const exitCode = new Promise(resolve => {
            server.on('exit', resolve);
        });

        await waitForServer();

        server.kill('SIGINT');
        expect(await exitCode).toBe(1);
    }, 15e3);

    it('exits for an unknown interaction model', async () => {
        const server = createServerProcess('bogus-interaction-model');

        const exitCode = new Promise(resolve => {
            server.on('exit', resolve);
        });
        expect(await exitCode).toBe(255);
    }, 15e3);
});
