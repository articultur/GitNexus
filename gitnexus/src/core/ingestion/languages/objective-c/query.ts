import Parser from 'tree-sitter';
import ObjectiveC from 'tree-sitter-objc';

const OBJECTIVE_C_SCOPE_QUERY = `
;; Scopes
(translation_unit) @scope.module
(class_interface) @scope.class
(class_implementation) @scope.class
(protocol_declaration) @scope.class
(function_definition) @scope.function
(method_declaration) @scope.function
(method_definition) @scope.function
(compound_statement) @scope.block

;; Classes / protocols
(class_interface
  (identifier) @declaration.name) @declaration.class

(class_implementation
  (identifier) @declaration.name) @declaration.class

(protocol_declaration
  (identifier) @declaration.name) @declaration.interface

;; Methods
(method_declaration
  (method_type)
  (identifier) @declaration.name) @declaration.method

(method_definition
  (method_type)
  (identifier) @declaration.name) @declaration.method

;; C functions
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @declaration.name)) @declaration.function

;; Imports
(preproc_include) @import.statement

;; Variable type bindings: Animal *animal = ...
(declaration
  type: (_) @type-binding.type
  declarator: (init_declarator
    declarator: (pointer_declarator
      declarator: (identifier) @type-binding.name))) @type-binding.assignment

(declaration
  type: (_) @type-binding.type
  declarator: (pointer_declarator
    declarator: (identifier) @type-binding.name)) @type-binding.assignment

;; Parameters
(parameter_declaration
  type: (_) @type-binding.type
  declarator: (identifier) @type-binding.name) @type-binding.parameter

(parameter_declaration
  type: (_) @type-binding.type
  declarator: (pointer_declarator
    declarator: (identifier) @type-binding.name)) @type-binding.parameter

;; Message sends and C calls
(message_expression
  receiver: (_) @reference.receiver
  method: (identifier) @reference.name) @reference.call.member

(call_expression
  function: (identifier) @reference.name) @reference.call.free
`;

let parser: Parser | null = null;
let query: Parser.Query | null = null;

export function getObjectiveCParser(): Parser {
  if (parser === null) {
    parser = new Parser();
    parser.setLanguage(ObjectiveC as Parameters<Parser['setLanguage']>[0]);
  }
  return parser;
}

export function getObjectiveCScopeQuery(): Parser.Query {
  if (query === null) {
    query = new Parser.Query(
      ObjectiveC as Parameters<Parser['setLanguage']>[0],
      OBJECTIVE_C_SCOPE_QUERY,
    );
  }
  return query;
}
