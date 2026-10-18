/** Build elements without interpreting profile or website strings as HTML. */
export function element(tag, attributes = {}, ...children) {
  const item = document.createElement(tag);
  for (const [key, attr] of Object.entries(attributes)) {
    if (key === "class") item.className = attr;
    else if (key === "onclick") item.addEventListener("click", attr);
    else item.setAttribute(key, attr);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== undefined && child !== null && typeof child !== "boolean") item.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return item;
}
