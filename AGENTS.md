---
name: application development
---

UI elements should not have ellipsis unless the text is being truncated
UI elements should be in title case unless otherwise prompted
Sentences should remain sentence case.

The quit UI element should just be "Quit" not "Quit <App Name>" in the menu bar
in dialogs use "Quit <App Name>?" or "Quit Application?" if name is not yet given

Errors should be shown as a dialog.

Hard coded strings for menus, dialogs and other UI elements should be stored in 
literally a single code file that is easy to edit. If multiple languages, one 
file per component. A component is loosely defined as "frontend UI" or "backend".

Keybinding preferences
- Use command for mac os
- Use super for linux
- Use super or ctrl for windows
- Common operations like cut copy paste etc should use the OS default.

Code should be run through a formatter and the config is committed

Avoid unnecessary comments and tests where behavior is obvious by reading the code
unnecessary means the code is simple to read and its behaviour can be easily 
inferred.

IMPORTANT: Ensure the application does not produce excessive disk writes.

Makefiles should at least include the following:
run, build, install, macos-install, linux-install, windows-install
install builds the version for that os and architecture and installs it

Do not generate an icon for the application when not explicitly prompted to.

when asked to do optimisations, create an OPTIMISATIONS.md file that tracks
what ideas have been proposed and if they were tested, what changed

Building the application should involve research on which algorithms or data 
structures to use before code is written. Research should be kept in RESEARCH.md

Do not hijack control of the user's computer. Hijack is launching applications that
perform UIinputs when the user has not explicitly said to, including launching the app.

Benchmark runs must be approved by the user e.g. go test -bench=. or cargo bench, 
etc.

Optimisation workflow should be first to apply and test the obvious fixes, 
and then profile before trying SIMD, cache layouts etc

list of optimisation techniques
- use better algorithms and data structures
- hoisting invariants
- deduplicate operations
- cache data for reuse
- batching operations
- non blocking code
- reduce memory allocation
- reduce syscalls
- reduce disk I/O
- parallel or concurrent code
