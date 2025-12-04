/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Uri } from "vscode";
import {
  COLAB_CLIENT_AGENT_HEADER,
  COLAB_RUNTIME_PROXY_TOKEN_HEADER,
} from "../../colab/headers";
import {
  Configuration,
  ConfigApi,
  ContentsApi,
  IdentityApi,
  KernelsApi,
  KernelspecsApi,
  SessionsApi,
  StatusApi,
  TerminalsApi,
} from "./generated";

export interface ConnectionInfo {
  readonly baseUrl: Uri;
  readonly token: string;
}

/**
 * The Jupyter Server API Client.
 */
export interface JupyterClient {
  readonly config: ConfigApi;
  readonly contents: ContentsApi;
  readonly identity: IdentityApi;
  readonly kernels: KernelsApi;
  readonly kernelspecs: KernelspecsApi;
  readonly sessions: SessionsApi;
  readonly status: StatusApi;
  readonly terminals: TerminalsApi;
}

/**
 * Creates a client for interacting with the Jupyter Server API via the Colab
 * proxy.
 */
export function createJupyterClient(
  connectionInfo: ConnectionInfo,
  getAccessToken: () => Promise<string>,
): JupyterClient {
  const config = new Configuration({
    basePath: connectionInfo.baseUrl.toString(),
    accessToken: getAccessToken,
    headers: {
      [COLAB_RUNTIME_PROXY_TOKEN_HEADER.key]: connectionInfo.token,
      [COLAB_CLIENT_AGENT_HEADER.key]: COLAB_CLIENT_AGENT_HEADER.value,
    },
  });

  let configApi: ConfigApi | undefined;
  let contentsApi: ContentsApi | undefined;
  let identityApi: IdentityApi | undefined;
  let kernelsApi: KernelsApi | undefined;
  let kernelspecsApi: KernelspecsApi | undefined;
  let sessionsApi: SessionsApi | undefined;
  let statusApi: StatusApi | undefined;
  let terminalsApi: TerminalsApi | undefined;

  // Lazily create the API objects as needed.
  return {
    get config() {
      return (configApi ??= new ConfigApi(config));
    },
    get contents() {
      return (contentsApi ??= new ContentsApi(config));
    },
    get identity() {
      return (identityApi ??= new IdentityApi(config));
    },
    get kernels() {
      return (kernelsApi ??= new KernelsApi(config));
    },
    get kernelspecs() {
      return (kernelspecsApi ??= new KernelspecsApi(config));
    },
    get sessions() {
      return (sessionsApi ??= new SessionsApi(config));
    },
    get status() {
      return (statusApi ??= new StatusApi(config));
    },
    get terminals() {
      return (terminalsApi ??= new TerminalsApi(config));
    },
  };
}
