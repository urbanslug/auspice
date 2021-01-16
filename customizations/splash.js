import React from "react";


export default function Splash({available}) {

  // const x = available.datasets.map(({request}) => request);
  const x = available.datasets ? available.datasets.map(({request}) => request) : [];
  const links = x.map((u) => <li key={u}> <a href={u}>{u}</a> </li>);

  return (
    <div style={{margin: "auto", width: "50%", fontSize: "18px", marginTop: "10px"}} >
      <h2>COVID-19 PubSeq: Public SARS-CoV-2 Sequence Resource</h2>
      <p>Available Datasets:</p>
      <ul> { links } </ul>
    </div>
  );
}
