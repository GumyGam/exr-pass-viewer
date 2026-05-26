// File System Access API folder walker. Replaces the old osascript-based
// `pick-folder` route + backend `scan_folder_tree`. The walk runs entirely in
// the browser; no bytes leave the user's machine.
//
// Behavior mirrors the Python scanner:
//   - recurse to `maxDepth` (root = depth 0)
//   - prune folders whose subtree has no .exr file
//   - sort siblings: folders first, then files; both alphabetically
//   - synthetic display path = "<rootName>/<sub>/<...>/<file>.exr"

import type { FileTreeNode, FolderTreeNode, TreeNode } from './types';

export type { FolderTreeNode, FileTreeNode, TreeNode };

const EXR_EXT = '.exr';

/** Show the native folder picker. Returns null on cancel or unsupported. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!('showDirectoryPicker' in window)) return null;
  try {
    // showDirectoryPicker lives on `window` in browsers that support it; the
    // DOM lib doesn't always type it.
    const w = window as unknown as {
      showDirectoryPicker: (opts?: {
        mode?: 'read' | 'readwrite';
      }) => Promise<FileSystemDirectoryHandle>;
    };
    return await w.showDirectoryPicker({ mode: 'read' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/** True if the FS Access folder-picker is available in this browser. */
export function fsAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

async function readEntries(
  dir: FileSystemDirectoryHandle,
): Promise<Array<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>> {
  // FS Access exposes the directory as an async iterable. The TS lib doesn't
  // type `.entries()`, so we cast through unknown.
  const iter = (
    dir as unknown as {
      entries: () => AsyncIterableIterator<
        [string, FileSystemDirectoryHandle | FileSystemFileHandle]
      >;
    }
  ).entries();
  const out: Array<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> = [];
  for await (const entry of iter) out.push(entry);
  return out;
}

async function walkRecursive(
  handle: FileSystemDirectoryHandle,
  parentPath: string,
  depth: number,
  maxDepth: number,
): Promise<FolderTreeNode | null> {
  const ownPath = parentPath ? `${parentPath}/${handle.name}` : handle.name;

  const children: TreeNode[] = [];
  if (depth < maxDepth) {
    const entries = await readEntries(handle);
    for (const [name, h] of entries) {
      if (name.startsWith('.')) continue;
      if (h.kind === 'directory') {
        const sub = await walkRecursive(
          h as FileSystemDirectoryHandle,
          ownPath,
          depth + 1,
          maxDepth,
        );
        if (sub) children.push(sub);
      } else if (h.kind === 'file') {
        if (!name.toLowerCase().endsWith(EXR_EXT)) continue;
        const fileHandle = h as FileSystemFileHandle;
        let file: File;
        try {
          file = await fileHandle.getFile();
        } catch {
          /* permission revoked / removed since iteration — drop the entry */
          continue;
        }
        const node: FileTreeNode = {
          name,
          path: `${ownPath}/${name}`,
          type: 'file',
          handle: fileHandle,
          size: file.size,
          file,
        };
        children.push(node);
      }
    }
  }

  // Prune branches with no .exr files anywhere underneath. A folder is
  // empty-by-pruning if its children list is empty after recursion.
  if (children.length === 0) return null;

  // Sort: folders first, then files; both alphabetical (case-insensitive).
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    name: handle.name,
    path: ownPath,
    type: 'folder',
    handle,
    children,
  };
}

/** Walk a picked directory and produce a synthetic tree. The root is always
 *  returned (even if empty) so the sidebar can show "no .exr files here" with
 *  the actual folder name. Returns null only if `maxDepth < 1`. */
export async function walkDirectory(
  handle: FileSystemDirectoryHandle,
  maxDepth = 6,
): Promise<FolderTreeNode> {
  if (maxDepth < 1) {
    return {
      name: handle.name,
      path: handle.name,
      type: 'folder',
      handle,
      children: [],
    };
  }
  const tree = await walkRecursive(handle, '', 0, maxDepth);
  if (tree) return tree;
  // No .exr anywhere — still return the root so the UI can render an empty tree.
  return {
    name: handle.name,
    path: handle.name,
    type: 'folder',
    handle,
    children: [],
  };
}

/** Walk a tree and yield every file node. Used by "select all" in a folder. */
export function collectFiles(node: TreeNode, out: FileTreeNode[] = []): FileTreeNode[] {
  if (node.type === 'file') {
    out.push(node);
    return out;
  }
  for (const c of node.children) collectFiles(c, out);
  return out;
}

/** Find a FileTreeNode by its synthetic path within a previously-walked tree. */
export function findFileByPath(node: TreeNode, path: string): FileTreeNode | null {
  if (node.type === 'file') return node.path === path ? node : null;
  if (!path.startsWith(node.path)) return null;
  for (const c of node.children) {
    const hit = findFileByPath(c, path);
    if (hit) return hit;
  }
  return null;
}
