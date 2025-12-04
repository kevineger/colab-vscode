/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from "buffer";
import vscode, {
  Disposable,
  Event,
  EventEmitter,
  FileChangeEvent,
  FileChangeType,
  FileStat,
  FileSystemError,
  FileSystemProvider,
  FileType,
  Uri,
  WorkspaceFolder,
} from "vscode";
import { ColabClient } from "../colab/client";
import { traceMethod } from "../common/logging/decorators";
import {
  ContentsApi,
  ContentsGetTypeEnum,
  ContentsSaveRequest,
  ResponseError,
} from "./client/generated";
import { ColabJupyterServerProvider } from "./provider";
import { ColabAssignedServer } from "./servers";

type Endpoint = string;

/**
 * Defines what VS Code needs to read, write, discover and manage files and
 * folders on the provided assigned Colab Jupyter
 * {@link ColabAssignedServer | server }.
 */
// TODO: Mutex where we read + write (e.g. in `write`)?
export class ContentsFileSystemProvider implements FileSystemProvider {
  /**
   * An event to signal that a resource has been created, changed, or deleted.
   * This event should fire for resources that are being
   * {@link FileSystemProvider.watch | watched} by clients of this provider.
   *
   * *Note:* It is important that the metadata of the file that changed provides
   * an updated `mtime` that advanced from the previous value in the
   * {@link FileStat | stat} and a correct `size` value. Otherwise there may be
   * optimizations in place that will not show the change in an editor for
   * example.
   */
  readonly onDidChangeFile: Event<FileChangeEvent[]>;

  private readonly servers = new Map<Endpoint, ContentsApi>();
  private readonly changeEmitter = new EventEmitter<FileChangeEvent[]>();

  constructor(
    private readonly vs: typeof vscode,
    private readonly colabClient: ColabClient,
    private readonly jupyterProvider: ColabJupyterServerProvider,
  ) {
    this.onDidChangeFile = this.changeEmitter.event;
    this.jupyterProvider.onDidAssignmentsChange(
      this.handleServerChange.bind(this),
    );
  }

  /**
   * Subscribes to file change events in the file or folder denoted by `uri`.
   * For folders, the option `recursive` indicates whether subfolders,
   * sub-subfolders, etc. should be watched for file changes as well. With
   * `recursive: false`, only changes to the files that are direct children of
   * the folder should trigger an event.
   *
   * The `excludes` array is used to indicate paths that should be excluded from
   * file watching. It is typically derived from the `files.watcherExclude`
   * setting that is configurable by the user. Each entry can be be:
   * - the absolute path to exclude
   * - a relative path to exclude (for example `build/output`)
   * - a simple glob pattern (for example `output/**`)
   *
   * It is the file system provider's job to call
   * {@link FileSystemProvider.onDidChangeFile | onDidChangeFile} for every
   * change given these rules. No event should be emitted for files that match
   * any of the provided excludes.
   *
   * @param uri - The uri of the file or folder to be watched.
   * @param options - Configures the watch.
   * @returns A disposable that tells the provider to stop watching the `uri`.
   */
  @traceMethod
  watch(
    _uri: Uri,
    _options: {
      /**
       * When enabled also watch subfolders.
       */
      readonly recursive: boolean;
      /**
       * A list of paths and pattern to exclude from watching.
       */
      readonly excludes: readonly string[];
    },
  ): Disposable {
    // Jupyter does not provide a standard WebSocket API for watching file
    // contents. We strictly implement the interface but do not support
    // watching.
    return new Disposable(() => {
      // No-op
    });
  }

  /**
   * Retrieve metadata about a file.
   *
   * Note that the metadata for symbolic links should be the metadata of the
   * file they refer to. Still, the
   * {@link FileType.SymbolicLink | SymbolicLink}-type must be used in addition
   * to the actual type, e.g. `FileType.SymbolicLink | FileType.Directory`.
   *
   * @param uri - The uri of the file to retrieve metadata about.
   * @returns The file metadata about the file.
   * @throws {@link FileSystemError.FileNotFound | FileNotFound} when `uri`
   * doesn't exist.
   */
  @traceMethod
  async stat(uri: Uri): Promise<FileStat> {
    const path = this.uriToPath(uri);
    try {
      const content = await this.getClient(uri).get({
        path,
        content: 0, // Metadata only
      });

      return {
        type: this.getContentType(content.type),
        ctime: content.created ? new Date(content.created).getTime() : 0,
        mtime: content.lastModified
          ? new Date(content.lastModified).getTime()
          : 0,
        size: content.size ?? 0,
      };
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Retrieve all entries of a {@link FileType.Directory | directory}.
   *
   * @param uri - The uri of the folder.
   * @returns An array of name/type-tuples or a thenable that resolves to such.
   * @throws {@link FileSystemError.FileNotFound | FileNotFound} when `uri`
   * doesn't exist.
   */
  @traceMethod
  async readDirectory(uri: Uri): Promise<[string, FileType][]> {
    const path = this.uriToPath(uri);
    try {
      const content = await this.getClient(uri).get({
        path,
        type: ContentsGetTypeEnum.Directory,
      });

      if (!Array.isArray(content.content)) {
        // Should not happen if type is directory
        throw FileSystemError.FileNotADirectory(uri);
      }

      // Explicitly cast content.content to Array<any> because generated types might be loose on 'content'
      const children = content.content as unknown as {
        name: string;
        type: string;
      }[];

      return children.map((child) => [
        child.name,
        this.getContentType(child.type),
      ]);
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Create a new directory (Note, that new files are created via
   * `write`-calls).
   *
   * @param uri - The uri of the new folder.
   * @throws {@link FileSystemError.FileNotFound | FileNotFound} when the parent
   * of `uri` doesn't exist, e.g. no mkdirp-logic required.
   * @throws {@link FileSystemError.FileExists | FileExists} when `uri` already
   * exists.
   * @throws {@link FileSystemError.NoPermissions | NoPermissions} when
   * permissions aren't sufficient.
   */
  @traceMethod
  async createDirectory(uri: Uri): Promise<void> {
    const path = this.uriToPath(uri);
    try {
      await this.getClient(uri).save({
        path,
        model: {
          type: ContentsGetTypeEnum.Directory,
        },
      });
      this.changeEmitter.fire([{ type: FileChangeType.Created, uri }]);
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Read the entire contents of a file.
   *
   * @param uri - The uri of the file.
   * @returns An array of bytes or a thenable that resolves to such.
   * @throws {@link FileSystemError.FileNotFound | FileNotFound } when `uri`
   * doesn't exist.
   */
  @traceMethod
  async readFile(uri: Uri): Promise<Uint8Array> {
    const path = this.uriToPath(uri);
    try {
      const content = await this.getClient(uri).get({
        path,
        format: "base64",
      });

      if (
        content.type === ContentsGetTypeEnum.Directory ||
        content.format !== "base64" ||
        typeof content.content !== "string"
      ) {
        throw FileSystemError.FileIsADirectory(uri);
      }

      return Buffer.from(content.content, "base64");
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Write data to a file, replacing its entire contents.
   *
   * @param uri - The uri of the file.
   * @param content - The new content of the file.
   * @param options - Defines if missing files should or must be created.
   * @throws {@link FileSystemError.FileNotFound | FileNotFound} when `uri`
   * doesn't exist and `create` is not set.
   * @throws {@link FileSystemError.FileNotFound | FileNotFound} when the parent
   * of `uri` doesn't exist and `create` is set, e.g. no mkdirp-logic required.
   * @throws {@link FileSystemError.FileExists | FileExists} when `uri` already
   * exists, `create` is set but `overwrite` is not set.
   * @throws {@link FileSystemError.NoPermissions | NoPermissions} when
   * permissions aren't sufficient.
   */
  @traceMethod
  async writeFile(
    uri: Uri,
    content: Uint8Array,
    options: {
      readonly create: boolean;
      readonly overwrite: boolean;
    },
  ): Promise<void> {
    const path = this.uriToPath(uri);

    let exists = false;
    if (!options.create || !options.overwrite) {
      try {
        await this.getClient(uri).get({ path, content: 0 });
        exists = true;
      } catch {
        // Ignore error, means file doesn't exist
      }

      if (!options.create && !exists) {
        throw FileSystemError.FileNotFound(uri);
      }
      if (!options.overwrite && exists) {
        throw FileSystemError.FileExists(uri);
      }
    }

    try {
      const model: ContentsSaveRequest = {
        content: Buffer.from(content).toString("base64"),
        format: "base64",
        type: ContentsGetTypeEnum.File,
      };

      await this.getClient(uri).save({
        path,
        model,
      });

      const eventType = exists
        ? FileChangeType.Changed
        : FileChangeType.Created;
      this.changeEmitter.fire([{ type: eventType, uri }]);
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Delete a file.
   *
   * @param uri - The resource that is to be deleted.
   * @param options - Defines if deletion of folders is recursive.
   * @throws {@link FileSystemError.FileNotFound | FileNotFound} when `uri`
   * doesn't exist.
   * @throws {@link FileSystemError.NoPermissions | NoPermissions} when
   * permissions aren't sufficient.
   */
  @traceMethod
  async delete(
    uri: Uri,
    options: {
      readonly recursive: boolean;
    },
  ): Promise<void> {
    const path = this.uriToPath(uri);
    try {
      if (!options.recursive) {
        const stat = await this.stat(uri);
        if (stat.type === FileType.Directory) {
          const children = await this.readDirectory(uri);
          if (children.length > 0) {
            throw FileSystemError.NoPermissions(
              "Cannot delete non-empty directory without recursive flag",
            );
          }
        }
      }

      await this.getClient(uri).delete({ path });
      this.changeEmitter.fire([{ type: FileChangeType.Deleted, uri }]);
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Rename a file or folder.
   *
   * @param oldUri - The existing file.
   * @param newUri - The new location.
   * @param options - Defines if existing files should be overwritten.
   * @throws {@link FileSystemError.FileNotFound | FileNotFound} when `oldUri`
   * doesn't exist.
   * @throws {@link FileSystemError.FileNotFound | FileNotFound} when parent of
   * `newUri` doesn't exist, e.g. no mkdirp-logic required.
   * @throws {@link FileSystemError.FileExists | FileExists} when `newUri`
   * exists and when the `overwrite` option is not `true`.
   * @throws {@link FileSystemError.NoPermissions | NoPermissions} when
   * permissions aren't sufficient.
   */
  @traceMethod
  async rename(
    oldUri: Uri,
    newUri: Uri,
    options: {
      readonly overwrite: boolean;
    },
  ): Promise<void> {
    if (oldUri.authority !== newUri.authority) {
      throw new Error("Renaming across servers is not currently supported");
    }

    const oldPath = this.uriToPath(oldUri);
    const newPath = this.uriToPath(newUri);

    if (!options.overwrite) {
      try {
        await this.getClient(oldUri).get({ path: newPath, content: 0 });
        throw FileSystemError.FileExists(newUri);
      } catch (e) {
        if (e instanceof FileSystemError) {
          throw e;
        }
        // Assuming not found, proceed
      }
    }

    try {
      await this.getClient(oldUri).rename({
        path: oldPath,
        rename: { path: newPath },
      });
      this.changeEmitter.fire([
        { type: FileChangeType.Deleted, uri: oldUri },
        { type: FileChangeType.Created, uri: newUri },
      ]);
    } catch (error) {
      this.handleError(error);
    }
  }

  private handleServerChange(servers: Set<ColabAssignedServer>) {
    // Create a set of current endpoints to efficiently find removed servers
    const newEndpoints = new Set<string>();
    for (const server of servers) {
      newEndpoints.add(server.endpoint);
      this.addOrUpdateServer(server);
    }

    // Remove servers that are no longer in the active set
    for (const endpoint of this.servers.keys()) {
      if (!newEndpoints.has(endpoint)) {
        this.removeServer(endpoint);
      }
    }
  }

  private addOrUpdateServer(server: ColabAssignedServer) {
    const isUpdate = this.servers.has(server.endpoint);
    // Always update the client to ensure we use the latest token/connection info.
    this.servers.set(
      server.endpoint,
      this.colabClient.jupyter(server).contents,
    );

    if (!isUpdate) {
      // Only add workspace folder if it's a newly discovered server
      const uri = this.serverUri(server);
      // Add the new folder at the end of the existing workspace folders
      const index = this.vs.workspace.workspaceFolders
        ? this.vs.workspace.workspaceFolders.length
        : 0;
      this.vs.workspace.updateWorkspaceFolders(index, 0, {
        uri,
        name: server.label,
      });
    } else {
      // If the server was just updated, check if its label has changed
      // WorkspaceFolder name is read-only. To update name, we must re-add. For
      // now, we skip this to avoid potential disruption (e.g., closing open
      // editors). A more robust solution would involve prompting the user or
      // accepting a stale name.
      const existingFolder = this.findWorkspaceFolder(server.endpoint);
      if (existingFolder && existingFolder.name !== server.label) {
        // To update the name, we would need to remove and re-add. For now, do
        // nothing. console.log(`Server label changed for ${server.endpoint},
        // but not updating workspace folder name to avoid disruption.`);
      }
    }
  }

  private removeServer(endpoint: string) {
    this.servers.delete(endpoint);
    const folder = this.findWorkspaceFolder(endpoint);
    if (folder) {
      // Remove the workspace folder from VS Code
      this.vs.workspace.updateWorkspaceFolders(folder.index, 1);
    }
  }

  private findWorkspaceFolder(endpoint: string): WorkspaceFolder | undefined {
    return this.vs.workspace.workspaceFolders?.find(
      (f) => f.uri.scheme === "colab" && f.uri.authority === endpoint,
    );
  }

  private serverUri(server: ColabAssignedServer): Uri {
    return this.vs.Uri.from({
      scheme: "colab",
      authority: server.endpoint,
      path: "/",
    });
  }

  private getClient(uri: Uri): ContentsApi {
    const client = this.servers.get(uri.authority);
    if (!client) {
      throw FileSystemError.Unavailable(
        `Server '${uri.authority}' is disconnected.`,
      );
    }
    return client;
  }

  private uriToPath(uri: Uri): string {
    // Jupyter expects paths relative to root, without leading slash.
    let path = uri.path;
    if (path.startsWith("/")) {
      path = path.slice(1);
    }
    return path;
  }

  private getContentType(type?: string): FileType {
    switch (type) {
      case "directory":
        return FileType.Directory;
      case "notebook":
      case "file":
      default:
        return FileType.File;
    }
  }

  private handleError(error: unknown): never {
    if (error instanceof ResponseError) {
      if (error.response.status === 404) {
        throw FileSystemError.FileNotFound();
      }
      if (error.response.status === 409) {
        throw FileSystemError.FileExists();
      }
      const code = error.response.status.toString();
      const text = error.response.statusText;
      throw new Error(`Jupyter contents error: ${code} ${text}`);
    }
    throw error;
  }
}
