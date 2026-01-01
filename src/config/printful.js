export async function printfulCreateOrder({ recipient, items }) {
  const key = process.env.PRINTFUL_API_KEY;
  if (!key) throw new Error("PRINTFUL_API_KEY missing");

  const res = await fetch("https://api.printful.com/orders", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ recipient, items })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Printful ${res.status}: ${text}`);
  return JSON.parse(text);
}
