# L Language Specification — Module System

**Specification:** 0.1.1\
**Status:** Normative\
**Scope:** Modules, imports, namespaces, name resolution, visibility and dependency cycles.

This document replaces sections 2.2 and 2.3 of Language L Specification 0.1.0.

> **Repository status (non-normative):** Source examples here use the currently
> implemented legacy bootstrap syntax. A typed, Nix-inspired source replacement
> is approved, with a broader syntax-only function/binding parser and a first
> executable C-function/local, `let/in` and conditional subset in the existing C
> compiler. The complete replacement grammar and executable-source migration
> remain unfinished. This note
> does not amend any rule below: module identity, explicit imports, resolution,
> visibility and dependency-cycle semantics remain normative. See the
> [source syntax status](../README.md#source-syntax-status) for the distinction
> between the implemented grammar and the replacement direction.

## 1. Module model

L uses an explicit, file-based module system.

A module is an independent compilation unit identified by a fully qualified module path.

Each `.l` source file MUST declare exactly one module.

Example:

```
module app.network.http;

import std.io;
import std.net;
```

The module identity consists of:

- Package identity
- Fully qualified module path
- Source file location

Module paths are case-sensitive.

A module MUST NOT be defined by more than one source file in the same package.

Multiple files contributing declarations to the same module are not supported in version 0.1.

### 1.1 Module naming

Module paths consist of dot-separated identifiers.

```
module app.main;
module app.network;
module app.network.http;
module std.io;
```

The dot (`.`) separates module path components.

The namespace resolution operator (`::`) is used for accessing declarations.

Example:

```
app::network::http::Client client;
```

### 1.2 File mapping

Module paths map to source files relative to a declared module source root.

Example source tree:

```
src/
├── app/
│   ├── main.l
│   ├── network.l
│   └── network/
│       └── http.l
└── std/
    └── io.l
```

Corresponding module declarations:

| File                     | Module             |
| ------------------------ | ------------------ |
| `src/app/main.l`          | `app.main`         |
| `src/app/network.l`       | `app.network`      |
| `src/app/network/http.l`  | `app.network.http` |
| `src/std/io.l`            | `std.io`           |

The module declaration MUST match the canonical path derived from the source root.

No implicit `index.l`, header files or directory merging are supported.

## 2. Import syntax

Imports are compile-time declarations.

They do not execute code and do not perform textual source inclusion.

All imports MUST appear after the module declaration and before other top-level declarations.

### 2.1 Module import

```
module app.main;

import std.io;
import std.network;
```

A module import makes the specified module available for qualified name resolution.

It does not automatically import individual declarations into the current scope.

Example:

```
import std.io;

int main() {
    std::io::println("Hello");
    return 0;
}
```

### 2.2 Module aliases

A module MAY be imported under an explicit alias.

```
import std.network.http as http;
```

Usage:

```
http::Client client;
```

The alias is local to the importing module.

Aliases MUST be unique within the module's import scope.

### 2.3 Selective imports

Individual public declarations can be imported directly.

```
import std.io::{
    println,
    read_line,
    write
};
```

Usage:

```
int main() {
    println("Hello");
    return 0;
}
```

Selective imports MAY rename declarations.

```
import std.io::{
    println as print,
    read_line as input
};
```

### 2.4 Wildcard imports

Wildcard imports are NOT supported in version 0.1.

The following syntax MUST produce a compilation error:

```
import std.io::*;
```

This restriction prevents accidental namespace pollution and ambiguous unqualified names.

### 2.5 Duplicate imports

Importing the same module more than once without conflicting aliases or bindings SHOULD generate a warning.

Conflicting aliases or selective imports MUST generate a compilation error.

### 2.6 Import restrictions

The following constructs are excluded from version 0.1:

- Textual `#include`
- Implicit module imports
- Implicit namespace imports
- Wildcard imports
- Conditional imports
- Runtime module loading
- Module re-exports
- Circular imports

## 3. Module resolution

Every import MUST resolve to exactly one module.

Module resolution MUST be deterministic and independent of the current working directory.

### 3.1 Module roots

The package manifest declares module source roots and dependency module prefixes.

A module prefix maps to exactly one package and source root.

Example conceptual manifest:

```
package {
    name = "my_application";

    module_roots = {
        app = "src/app";
    };

    dependencies = {
        std = "standard_library";
        networking = "networking_package";
    };
}
```

The exact manifest representation is defined by the build-system specification.

### 3.2 Resolution procedure

For an import:

```
import networking.http;
```

The compiler MUST:

1. Parse the module path.
2. Identify the matching module prefix from the package dependency graph.
3. Resolve the remaining path relative to the associated source root.
4. Map the path to a `.l` source file.
5. Verify the module declaration.
6. Verify that the module is accessible.
7. Add the resolved module to the dependency graph.

The longest matching registered module prefix MUST be selected.

If two package registrations have equally valid resolution for a module path, compilation MUST fail with an ambiguity error.

The compiler MUST NOT silently select one candidate.

### 3.3 Resolution failures

The compiler MUST distinguish:

- Module not found
- Invalid module path
- Duplicate module definition
- Invalid module declaration
- Ambiguous module resolution
- Missing package dependency
- Inaccessible module

These failures MUST be reported during semantic analysis, before code generation.

### 3.4 No implicit search paths

The compiler MUST NOT search:

- The process working directory
- Arbitrary system directories
- Unregistered package directories
- Environment-dependent source locations

All source roots MUST be declared by the build configuration.

## 4. Visibility

Visibility is defined at the module declaration level.

Declarations are private by default.

### 4.1 Private declarations

```
module app.database;

struct Connection {
    int handle;
};

int internal_helper() {
    return 0;
}
```

Without `pub`, declarations are visible only inside their defining module.

Sibling modules MUST NOT access private declarations.

### 4.2 Public declarations

The `pub` modifier exports a declaration from its module.

```
module app.database;

pub struct Connection {
    int handle;
};

pub int connect() {
    return 0;
}
```

Another module can access these declarations through an import.

```
module app.main;

import app.database;

int main() {
    app::database::Connection connection;
    return app::database::connect();
}
```

A public declaration MUST have all required publicly accessible types in its signature.

A public function MUST NOT expose an inaccessible private type through its public interface.

### 4.3 Visibility rules

| Declaration                   | Default visibility |
| ----------------------------- | ------------------ |
| Functions                     | Private            |
| Structs                       | Private            |
| Classes                       | Private            |
| Enums                         | Private            |
| Type aliases                  | Private            |
| Constants                     | Private            |
| Global variables              | Private            |
| Namespaces                    | Module-scoped      |
| Public declaration with `pub`  | Public             |

The `pub` modifier is required for external module access.

### 4.4 Struct and class members

Module visibility and member visibility are separate concepts.

Struct members are public by default.

```
pub struct User {
    string name;
    int age;
};
```

Class members are private by default.

```
pub class Database {
public:
    void connect();

private:
    int handle;
};
```

External module visibility does not override class access restrictions.

### 4.5 Private access

Private declarations can be referenced:

- From functions in their defining module
- From other namespaces in their defining module
- From other declarations in the same module

Private declarations cannot be referenced from another module, even when that module belongs to the same package.

### 4.6 Re-exports

Re-exporting imported declarations is not supported in version 0.1.

A module MUST NOT expose declarations from another module through an implicit import.

A future specification MAY introduce explicit public re-exports.

## 5. Namespaces

Namespaces organize declarations inside modules.

They are logical scopes and do not constitute separate compilation units.

Example:

```
module app.main;

namespace network {
    struct Client {
        int socket;
    };

    int connect() {
        return 0;
    }
}
```

Access:

```
network::Client client;
network::connect();
```

### 5.1 Nested namespaces

```
namespace graphics {
    namespace rendering {
        struct Renderer {
            int width;
            int height;
        };
    }
}
```

Access:

```
graphics::rendering::Renderer renderer;
```

### 5.2 Namespace reopening

A namespace MAY appear multiple times within one module.

Declarations in reopened namespaces belong to the same logical namespace.

Duplicate symbol definitions MUST be rejected.

### 5.3 Namespace limitations

Namespaces MUST NOT:

- Cross module boundaries implicitly
- Change declaration visibility
- Create runtime objects
- Perform initialization
- Introduce implicit imports

Namespaces are compile-time organizational structures.

## 6. Name lookup

Name resolution MUST follow a deterministic lookup algorithm.

### 6.1 Unqualified name lookup

For an unqualified identifier, the compiler searches:

1. Current lexical scope.
2. Enclosing lexical scopes.
3. Enclosing namespace scopes.
4. Current module scope.
5. Explicit selective imports.

Local declarations MAY shadow imported names according to ordinary lexical scoping rules.

Two selective imports introducing the same unqualified name MUST produce an ambiguity error unless the conflict is resolved with explicit aliases.

There is no implicit global namespace import.

### 6.2 Qualified name lookup

Qualified expressions use `::`.

Examples:

```
std::io::println("Hello");
app::network::Client client;
http::Request request;
```

The first component MUST resolve to one of:

- A registered imported module path
- An imported module alias
- A declaration in the current module
- An enclosing namespace

Every subsequent component is resolved within the preceding module, namespace or type.

A failed qualified lookup MUST NOT fall back to unqualified lookup.

### 6.3 Shadowing

Local variables and parameters MAY shadow declarations in outer lexical scopes.

Imported module aliases MUST NOT be shadowed by declarations in the same module scope.

Duplicate declarations in the same lexical scope MUST be rejected unless the language explicitly supports overloads for the relevant declaration category.

### 6.4 Overloading

Function overloading is supported.

```
int calculate(int value);
float calculate(float value);
```

The compiler resolves overloaded functions using static parameter types and generic constraints.

Dynamic arguments require runtime overload resolution only when explicitly supported by the dynamic call model.

## 7. Circular dependency handling

Version 0.1 uses a strictly acyclic module dependency graph.

Circular imports are prohibited.

### 7.1 Dependency graph

Each module is represented as a directed graph node.

An import creates a directed dependency edge.

For example:

```
app.main
   |
   v
app.network
   |
   v
app.database
```

Every module dependency graph MUST be a directed acyclic graph (DAG).

### 7.2 Cycle detection

The compiler MUST detect cycles after resolving all imports and before code generation.

A depth-first search with three-state visitation or an equivalent graph algorithm MAY be used.

The compiler MUST detect:

- Direct self-imports
- Two-module cycles
- Multi-module cycles
- Cycles involving standard library modules
- Cycles crossing package boundaries

### 7.3 Cycle errors

Example:

```
// app.a
module app.a;
import app.b;

// app.b
module app.b;
import app.a;
```

The compiler MUST reject the dependency graph.

Expected diagnostic:

```
Module dependency cycle detected.

  app.a
    -> app.b
    -> app.a

Circular module dependencies are not supported
in Language L 0.1.
```

The compiler SHOULD report the complete cycle path.

### 7.4 No partial module compilation

The compiler MUST NOT resolve a circular dependency by exposing partially compiled modules.

Partially initialized module symbols are not permitted.

Import cycles are rejected regardless of whether they contain only types or runtime functions.

Type-only imports and forward module declarations are not supported in version 0.1.

### 7.5 Compilation order

After successful cycle detection, modules MUST be processed in dependency order.

A module may be semantically analyzed only after the interfaces of its dependencies are available.

Function recursion inside a module remains legal.

Cross-module mutual recursion is not supported in version 0.1.

Future versions MAY introduce explicitly declared interface modules or type-only imports to support more complex dependency graphs.

## 8. Module initialization

Modules do not have executable initialization blocks in version 0.1.

Top-level declarations are limited to:

- Functions
- Structs
- Classes
- Enums
- Type aliases
- Constants
- Static storage declarations

Module-level constants MUST be initialized using compile-time constant expressions.

Mutable module-level storage MUST use explicit `static` declarations and compile-time initializers.

Example:

```
module app.counter;

static int counter = 0;
const int maximum = 100;
```

The compiler MUST NOT execute arbitrary module initialization code before `main`.

This guarantees that importing a module does not introduce hidden runtime side effects.

Static storage with a constant initializer is initialized before `main`, following the target runtime's defined zero-initialization and constant-initialization rules.

## 9. Semantic analysis pipeline

The compiler MUST implement module processing in the following order:

1. Discover source modules from declared source roots.
2. Parse module declarations.
3. Register module identities.
4. Parse import declarations.
5. Resolve module paths.
6. Construct the module dependency graph.
7. Detect duplicate module definitions.
8. Detect circular dependencies.
9. Determine dependency compilation order.
10. Register module and namespace symbols.
11. Check declaration visibility.
12. Resolve imported symbols.
13. Perform type checking.
14. Perform generic instantiation as required.
15. Generate typed intermediate representation.
16. Continue into ownership analysis and backend lowering.

This ordering ensures that module lookup does not depend on filesystem traversal order or compilation timing.

## 10. Compatibility and future extensions

The following features are deliberately excluded from version 0.1:

- Wildcard imports
- Module re-exports
- Circular imports
- Partial module compilation
- Type-only imports
- Runtime imports
- Conditional imports
- Multiple files per module
- Header inclusion
- Implicit module search paths
- Implicit standard library imports

Future versions MAY introduce additional capabilities, provided existing import and visibility semantics remain compatible.

**Normative summary:**

Language L uses one source file per module, explicit imports, explicit aliases, selective imports, private-by-default declarations, explicit public exports, deterministic name lookup and a strictly acyclic module dependency graph.

The module system is compile-time only. Importing a module MUST NOT execute code or introduce implicit runtime initialization.
