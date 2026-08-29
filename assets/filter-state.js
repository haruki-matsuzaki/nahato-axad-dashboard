export function retainProjectFilter(projects, selectedProject) {
  const selected = typeof selectedProject === "string" && selectedProject ? selectedProject : "all";
  const retainedProjects = [...new Set((projects || []).filter(Boolean))];

  if (selected !== "all" && !retainedProjects.includes(selected)) {
    retainedProjects.push(selected);
  }

  return {
    projects: retainedProjects,
    selectedProject: selected,
  };
}
