# Explain unresolved personal-fork sync context

A literal `gh repo sync` with a matching organization source for a rostered repository at `propose` access or higher remains denied when the gate cannot resolve a local clone identity. Its denial names the missing local repository context and clone without an absolute path, and states that the denial is final and the blocked command cannot be automatically retried. Other destinations and access levels keep their existing denial reason.
