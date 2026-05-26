// Browser-side tree types. The display `path` is synthetic — derived from
// directory names during the walk — because the FS Access API never exposes
// real filesystem paths. It is stable for the lifetime of a directory handle
// and unique within the picked root, so we use it as a Map key everywhere
// the old HTTP API used the absolute path.

export interface FolderTreeNode {
  name: string;
  path: string;
  type: 'folder';
  handle: FileSystemDirectoryHandle;
  children: TreeNode[];
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file';
  handle: FileSystemFileHandle;
  size: number;
  /** Resolved File at walk time. We cache it on the node so panels can read
   *  bytes without round-tripping through the handle a second time. */
  file: File;
}

export type TreeNode = FolderTreeNode | FileTreeNode;
