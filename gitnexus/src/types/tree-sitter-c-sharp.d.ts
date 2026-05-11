type TreeSitterCSharpBaseNode = {
  type: string;
  named: boolean;
};

type TreeSitterCSharpChildNode = {
  multiple: boolean;
  required: boolean;
  types: TreeSitterCSharpBaseNode[];
};

type TreeSitterCSharpNodeInfo =
  | (TreeSitterCSharpBaseNode & {
      subtypes: TreeSitterCSharpBaseNode[];
    })
  | (TreeSitterCSharpBaseNode & {
      fields: { [name: string]: TreeSitterCSharpChildNode };
      children: TreeSitterCSharpChildNode[];
    });

type TreeSitterCSharpLanguage = {
  language: unknown;
  nodeTypeInfo: TreeSitterCSharpNodeInfo[];
  HIGHLIGHTS_QUERY?: string;
  INJECTIONS_QUERY?: string;
  LOCALS_QUERY?: string;
  TAGS_QUERY?: string;
};

declare module 'tree-sitter-c-sharp' {
  const csharp: TreeSitterCSharpLanguage;
  export default csharp;
}

declare module 'tree-sitter-c-sharp/bindings/node/index.js' {
  const csharp: TreeSitterCSharpLanguage;
  export default csharp;
}
