/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  commands,
  Disposable,
  Event,
  EventEmitter,
  ExtensionContext,
  FileChangeEvent,
  FileChangeType,
  FileType,
  TreeDataProvider,
  TreeItem,
  Uri,
  window,
  workspace,
} from 'vscode';
import { AuthChangeEvent } from '../../auth/auth-provider';
import { log } from '../../common/logging';
import {
  AssignmentChangeEvent,
  AssignmentManager,
} from '../../jupyter/assignments';
import { ServerItem } from './server-item';

export function registerTreeCommands(
  context: ExtensionContext,
  tree: ServerTreeProvider,
) {
  context.subscriptions.push(
    commands.registerCommand('colab.renameFile', async (node: ServerItem) => {
      const oldName =
        typeof node.label === 'string' ? node.label : node.label?.label;
      const prompt = `Rename${oldName ? ` ${oldName}` : ''}`;
      const newName = await window.showInputBox({
        placeHolder: 'Enter the new name',
        prompt,
        value: oldName,
      });

      if (!newName || newName === oldName) {
        return;
      }

      const parentUri = Uri.joinPath(node.uri, '..');
      const newUri = Uri.joinPath(parentUri, newName);

      try {
        await workspace.fs.rename(node.uri, newUri, { overwrite: false });

        tree.refresh();
      } catch (error) {
        // TODO: Better handle errors (e.g., name conflicts).
        window.showErrorMessage(`Could not rename file`);
        log.error('Error renaming file', error);
      }
    }),
  );
}

/**
 * A TreeDataProvider for the server browser view.
 *
 * Handles displaying servers and their file/folder structure. Reacts to
 * authorization state, assignment and file changes.
 */
export class ServerTreeProvider
  implements TreeDataProvider<ServerItem>, Disposable
{
  private changeEmitter = new EventEmitter<
    ServerItem | ServerItem[] | undefined
  >();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly authListener: Disposable;
  private readonly assignmentListener: Disposable;
  private readonly fileListener: Disposable;
  // VS Code uses referential equality to identify TreeItems, so we need to
  // cache them to ensure we event with the same instance as returned by
  // `getChildren`.
  private serverItemsByUri = new Map<string, ServerItem>();
  private isAuthorized = false;
  private isDisposed = false;

  constructor(
    private readonly assignments: AssignmentManager,
    authChange: Event<AuthChangeEvent>,
    assignmentChange: Event<AssignmentChangeEvent>,
    fileChange: Event<FileChangeEvent[]>,
  ) {
    this.authListener = authChange(this.handleAuthChange.bind(this));
    this.assignmentListener = assignmentChange(this.refresh.bind(this));
    this.fileListener = fileChange(this.handleFileChange.bind(this));
  }

  dispose() {
    if (this.isDisposed) {
      return;
    }
    this.authListener.dispose();
    this.assignmentListener.dispose();
    this.fileListener.dispose();
    this.serverItemsByUri.clear();
    this.isDisposed = true;
  }

  refresh(): void {
    this.guardDisposed();
    this.serverItemsByUri.clear();
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: ServerItem): TreeItem {
    this.guardDisposed();
    return element;
  }

  async getChildren(element?: ServerItem): Promise<ServerItem[]> {
    this.guardDisposed();
    if (!this.isAuthorized) {
      return [];
    }
    if (element?.uri) {
      return this.getServerItems(element.uri);
    }
    const servers = await this.assignments.getServers('extension');
    const items: ServerItem[] = [];
    for (const s of servers) {
      const rootUri = Uri.parse(`colab://${s.endpoint}/content`);
      const root = new ServerItem(
        s.endpoint,
        s.label,
        FileType.Directory,
        rootUri,
      );
      items.push(root);
      this.serverItemsByUri.set(rootUri.toString(), root);
    }
    return items;
  }

  private handleAuthChange(e: AuthChangeEvent) {
    if (this.isAuthorized === e.hasValidSession) {
      return;
    }
    this.isAuthorized = e.hasValidSession;
    this.refresh();
  }

  private handleFileChange(events: FileChangeEvent[]) {
    const items: ServerItem[] = [];
    for (const event of events) {
      if (event.type === FileChangeType.Changed) {
        // File mutations don't affect the tree structure.
        continue;
      }
      if (event.type === FileChangeType.Deleted) {
        this.serverItemsByUri.delete(event.uri.toString());
      }
      const parentUri = getParent(event.uri);
      if (!parentUri || parentUri.path === '/') {
        this.refresh();
        return;
      }
      const item = this.serverItemsByUri.get(parentUri.toString());
      if (!item) {
        this.refresh();
        return;
      }
      items.push(item);
    }
    if (!items.length) {
      return;
    }
    this.changeEmitter.fire(items);
  }

  private async getServerItems(uri: Uri): Promise<ServerItem[]> {
    const entries = await workspace.fs.readDirectory(uri);

    return entries.map(([name, type]) => {
      const itemUri = Uri.joinPath(uri, name);
      const item = new ServerItem(uri.authority, name, type, itemUri);
      this.serverItemsByUri.set(itemUri.toString(), item);
      return item;
    });
  }

  private guardDisposed() {
    if (!this.isDisposed) {
      return;
    }
    throw new Error(
      'ServerTreeProvider cannot be used after it has been disposed.',
    );
  }
}

function getParent(uri: Uri): Uri | undefined {
  if (uri.path === '/') {
    return undefined;
  }
  return Uri.joinPath(uri, '..');
}
