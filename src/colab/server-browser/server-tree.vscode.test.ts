/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { assert, expect } from 'chai';
import sinon, { SinonStubbedInstance } from 'sinon';
import vscode, {
  FileChangeEvent,
  FileType,
  TreeItemCollapsibleState,
  Uri,
} from 'vscode';
import { AuthChangeEvent } from '../../auth/auth-provider';
import {
  AssignmentChangeEvent,
  AssignmentManager,
} from '../../jupyter/assignments';
import { ContentsFileSystemProvider } from '../../jupyter/contents/file-system';
import { ColabAssignedServer } from '../../jupyter/servers';
import { TestEventEmitter } from '../../test/helpers/events';
import { Variant } from '../api';
import { buildColabFileUri } from '../files';
import {
  COLAB_CLIENT_AGENT_HEADER,
  COLAB_RUNTIME_PROXY_TOKEN_HEADER,
} from '../headers';
import { ServerTreeProvider } from './server-tree';

const DEFAULT_SERVER: ColabAssignedServer = {
  id: randomUUID(),
  label: 'Colab GPU A100',
  variant: Variant.GPU,
  accelerator: 'A100',
  endpoint: 'm-s-foo',
  connectionInformation: {
    baseUrl: Uri.parse('https://example.com'),
    token: '123',
    tokenExpiry: new Date(Date.now() + 1000 * 60 * 60),
    headers: {
      [COLAB_RUNTIME_PROXY_TOKEN_HEADER.key]: '123',
      [COLAB_CLIENT_AGENT_HEADER.key]: COLAB_CLIENT_AGENT_HEADER.value,
    },
  },
  dateAssigned: new Date(),
};
const DEFAULT_SERVER_URI = buildColabFileUri(vscode, DEFAULT_SERVER, 'content');

describe('ServerTreeProvider', () => {
  let assignmentStub: SinonStubbedInstance<AssignmentManager>;
  let authChangeEmitter: TestEventEmitter<AuthChangeEvent>;
  let assignmentChangeEmitter: TestEventEmitter<AssignmentChangeEvent>;
  let fileChangeEmitter: TestEventEmitter<FileChangeEvent[]>;
  let fsStub: SinonStubbedInstance<ContentsFileSystemProvider>;
  let tree: ServerTreeProvider;
  let fsDisposable: vscode.Disposable;

  enum AuthState {
    SIGNED_OUT,
    SIGNED_IN,
  }

  /**
   * Fires the auth change event emitter, simply toggling whether there's an
   * active session or not.
   */
  function toggleAuth(s: AuthState): void {
    authChangeEmitter.fire({
      added: [],
      changed: [],
      removed: [],
      hasValidSession: s === AuthState.SIGNED_IN ? true : false,
    });
  }

  beforeEach(() => {
    assignmentStub = sinon.createStubInstance(AssignmentManager);
    authChangeEmitter = new TestEventEmitter<AuthChangeEvent>();
    assignmentChangeEmitter = new TestEventEmitter<AssignmentChangeEvent>();
    fileChangeEmitter = new TestEventEmitter<FileChangeEvent[]>();
    fsStub = sinon.createStubInstance(ContentsFileSystemProvider);
    // Needed to work around the property being readonly.
    Object.defineProperty(fsStub, 'onDidChangeFile', {
      value: sinon.stub().callsFake(fileChangeEmitter.event),
    });
    fsDisposable = vscode.workspace.registerFileSystemProvider(
      'colab',
      fsStub,
      { isCaseSensitive: true },
    );

    tree = new ServerTreeProvider(
      assignmentStub,
      authChangeEmitter.event,
      assignmentChangeEmitter.event,
      fileChangeEmitter.event,
    );
  });

  afterEach(() => {
    fsDisposable.dispose();
    sinon.restore();
  });

  describe('getChildren', () => {
    describe('without servers', () => {
      beforeEach(() => {
        (assignmentStub.getServers as sinon.SinonStub).returns([]);
      });

      it('returns no items with unauthorized', async () => {
        await expect(tree.getChildren(undefined)).to.eventually.deep.equal([]);

        sinon.assert.notCalled(fsStub.readDirectory);
      });

      it('returns no items while authorized', async () => {
        toggleAuth(AuthState.SIGNED_IN);

        await expect(tree.getChildren(undefined)).to.eventually.deep.equal([]);

        sinon.assert.notCalled(fsStub.readDirectory);
      });
    });

    describe('with a server', () => {
      beforeEach(() => {
        (assignmentStub.getServers as sinon.SinonStub).returns([
          DEFAULT_SERVER,
        ]);
      });

      it('returns no items with unauthorized', async () => {
        await expect(tree.getChildren(undefined)).to.eventually.deep.equal([]);

        sinon.assert.notCalled(fsStub.readDirectory);
      });

      describe('while authorized', () => {
        beforeEach(() => {
          toggleAuth(AuthState.SIGNED_IN);
        });

        it('returns the server root', async () => {
          await expect(tree.getChildren(undefined)).to.eventually.deep.equal([
            {
              id: DEFAULT_SERVER_URI.toString(),
              endpoint: DEFAULT_SERVER.endpoint,
              type: FileType.Directory,
              uri: DEFAULT_SERVER_URI,
              resourceUri: DEFAULT_SERVER_URI,
              label: DEFAULT_SERVER.label,
              collapsibleState: TreeItemCollapsibleState.Collapsed,
              contextValue: 'server',
            },
          ]);
        });

        it('returns a file', async () => {
          const rootServerItems = await tree.getChildren(undefined);
          assert(rootServerItems.length === 1);
          const rootServerItem = rootServerItems[0];
          fsStub.readDirectory
            .withArgs(DEFAULT_SERVER_URI)
            .resolves([['foo.txt', FileType.File]]);
          const fileUri = buildColabFileUri(
            vscode,
            DEFAULT_SERVER,
            'content/foo.txt',
          );

          await expect(
            tree.getChildren(rootServerItem),
          ).to.eventually.deep.equal([
            {
              id: fileUri.toString(),
              endpoint: DEFAULT_SERVER.endpoint,
              type: FileType.File,
              uri: fileUri,
              resourceUri: fileUri,
              label: 'foo.txt',
              collapsibleState: TreeItemCollapsibleState.None,
              contextValue: 'file',
              command: {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [fileUri],
              },
            },
          ]);
        });

        it('returns a directory', async () => {
          const rootServerItems = await tree.getChildren(undefined);
          assert(rootServerItems.length === 1);
          const rootServerItem = rootServerItems[0];
          fsStub.readDirectory
            .withArgs(DEFAULT_SERVER_URI)
            .resolves([['foo', FileType.Directory]]);
          const folderUri = buildColabFileUri(
            vscode,
            DEFAULT_SERVER,
            'content/foo',
          );

          await expect(
            tree.getChildren(rootServerItem),
          ).to.eventually.deep.equal([
            {
              id: folderUri.toString(),
              endpoint: DEFAULT_SERVER.endpoint,
              type: FileType.Directory,
              uri: folderUri,
              resourceUri: folderUri,
              label: 'foo',
              collapsibleState: TreeItemCollapsibleState.Collapsed,
              contextValue: 'folder',
            },
          ]);
        });

        it('returns a combination of files and folders', async () => {
          const rootServerItems = await tree.getChildren(undefined);
          assert(rootServerItems.length === 1);
          const rootServerItem = rootServerItems[0];
          fsStub.readDirectory.withArgs(DEFAULT_SERVER_URI).resolves([
            ['foo.txt', FileType.File],
            ['bar.txt', FileType.File],
            ['baz', FileType.Directory],
            ['cux', FileType.Directory],
          ]);

          const children = await tree.getChildren(rootServerItem);

          expect(
            children.map((c) => ({
              label: c.label,
              contextValue: c.contextValue,
            })),
          ).to.deep.equal([
            { label: 'foo.txt', contextValue: 'file' },
            { label: 'bar.txt', contextValue: 'file' },
            { label: 'baz', contextValue: 'folder' },
            { label: 'cux', contextValue: 'folder' },
          ]);
        });

        it('returns nested files and folders', async () => {
          const rootServerItems = await tree.getChildren(undefined);
          assert(rootServerItems.length === 1);
          const rootServerItem = rootServerItems[0];
          fsStub.readDirectory
            .withArgs(DEFAULT_SERVER_URI)
            .resolves([['foo', FileType.Directory]]);
          const rootChildren = await tree.getChildren(rootServerItem);
          assert(rootChildren.length === 1);
          const fooFolder = rootChildren[0];
          const fooUri = buildColabFileUri(
            vscode,
            DEFAULT_SERVER,
            'content/foo',
          );
          fsStub.readDirectory.withArgs(fooUri).resolves([
            ['bar.txt', FileType.File],
            ['baz', FileType.Directory],
          ]);

          const fooChildren = await tree.getChildren(fooFolder);

          expect(
            fooChildren.map((c) => ({
              label: c.label,
              contextValue: c.contextValue,
            })),
          ).to.deep.equal([
            { label: 'bar.txt', contextValue: 'file' },
            { label: 'baz', contextValue: 'folder' },
          ]);
        });
      });
    });
  });
});
