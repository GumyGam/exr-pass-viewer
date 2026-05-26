import { useMemo, useState } from 'react';
import type { FileTreeNode, TreeNode } from '../fs/types';
import { collectFiles } from '../fs/walker';
import { useViewerStore } from '../store/viewerStore';
import { formatBytes } from '../utils/format';

type RowKind = 'folder' | 'file';
type Row = {
  kind: RowKind;
  node: TreeNode;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
};

function flatten(
  node: TreeNode,
  expanded: Set<string>,
  rows: Row[],
  depth: number,
) {
  const hasChildren = node.type === 'folder' && node.children.length > 0;
  const isOpen = node.type === 'folder' ? expanded.has(node.path) : false;
  rows.push({
    kind: node.type,
    node,
    depth,
    expanded: isOpen,
    hasChildren,
  });
  if (node.type === 'folder' && isOpen) {
    for (const c of node.children) flatten(c, expanded, rows, depth + 1);
  }
}

export function FolderTree({ tree }: { tree: TreeNode | null }) {
  const selectedFiles = useViewerStore((s) => s.selectedFiles);
  const toggleFile = useViewerStore((s) => s.toggleFile);
  const setSelectedFiles = useViewerStore((s) => s.setSelectedFiles);

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    if (!tree || tree.type !== 'folder') return new Set();
    return new Set([tree.path]);
  });

  const rows = useMemo(() => {
    if (!tree) return [];
    const out: Row[] = [];
    flatten(tree, expanded, out, 0);
    return out;
  }, [tree, expanded]);

  const totalFiles = useMemo(() => {
    if (!tree) return 0;
    return collectFiles(tree).length;
  }, [tree]);

  if (!tree) {
    return <div className="tree-empty">No folder selected — click the picker above.</div>;
  }

  const toggleFolder = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleFolderFiles = (node: TreeNode) => {
    const inside: FileTreeNode[] = collectFiles(node);
    if (inside.length === 0) return;
    const allSelected = inside.every((f) => selectedFiles.includes(f.path));
    if (allSelected) {
      const insideSet = new Set(inside.map((f) => f.path));
      setSelectedFiles(selectedFiles.filter((p) => !insideSet.has(p)));
    } else {
      const merged = new Set([...selectedFiles, ...inside.map((f) => f.path)]);
      setSelectedFiles(Array.from(merged));
    }
  };

  return (
    <>
      <div
        className="sidebar-label"
        style={{
          marginBottom: 10,
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>Library</span>
        <span
          className="mono"
          style={{ color: 'var(--text-3)', fontSize: 9, textTransform: 'none', letterSpacing: 0 }}
        >
          {totalFiles} files
        </span>
      </div>
      <div className="tree">
        {rows.map((r) => {
          const path = r.node.path;
          const isFile = r.kind === 'file';
          const isSelected = isFile && selectedFiles.includes(path);
          return (
            <div
              key={path + '@' + r.depth}
              className={`tree-node ${isSelected ? 'selected' : ''}`}
              onClick={(e) => {
                if (isFile) {
                  toggleFile(path);
                } else if (e.metaKey) {
                  toggleFolderFiles(r.node);
                } else {
                  toggleFolder(path);
                }
              }}
            >
              {Array.from({ length: r.depth }).map((_, i) => (
                <span key={i} className="tree-indent" />
              ))}
              {r.kind === 'folder' ? (
                <span className="caret">{r.expanded ? '▾' : '▸'}</span>
              ) : (
                <span
                  className={`check ${isSelected ? 'on' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFile(path);
                  }}
                />
              )}
              <span className="ico">{r.kind === 'folder' ? '▣' : '●'}</span>
              <span className="tree-name">{r.node.name}</span>
              {r.kind === 'file' && (
                <span className="tree-meta">{formatBytes((r.node as FileTreeNode).size)}</span>
              )}
              {r.kind === 'folder' && r.hasChildren && (
                <span className="tree-meta">{(r.node as { children: TreeNode[] }).children.length}</span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
