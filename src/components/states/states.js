import React from "react";
import { connect } from "react-redux";
import { withTranslation } from "react-i18next";
import _max from "lodash/max";
import { select, event as d3event } from "d3-selection";
import { interpolateNumber } from "d3-interpolate";
import { forceSimulation, forceManyBody } from "d3-force";
import { drag as d3drag } from "d3-drag";
import { arc } from "d3-shape";
import ErrorBoundary from "../../util/errorBoundry";
import Legend from "../tree/legend/legend";
import Card from "../framework/card";
import { getVisibleNodesPerLocation, createOrUpdateArcs } from "../map/mapHelpersLatLong";
import { getAverageColorFromNodes } from "../../util/colorHelpers";
import { pathStringGenerator, extractLineSegmentForAnimationEffect } from "../map/mapHelpers";
import { getTraitFromNode } from "../../util/treeMiscHelpers";
import { bezier } from "../map/transmissionBezier";
import { NODE_NOT_VISIBLE, demeCountMultiplier, demeCountMinimum } from "../../util/globals";
import { updateTipRadii } from "../../actions/tree";
import { isColorByGenotype } from "../../util/getGenotype";

/**
 * This is a prototype.
 * There are numerous calls into functions and use of data structures designed
 * for the <Map> component. These are unnecessarily complex for this use case,
 * but are employed to simplify the creation of a prototype without needing
 * to refactor shared functions or duplicate code.
 */

/**  Known to-do list before release:
 * improve physics, especially related to SVG boundary
 * improve initial layout
 * don't recreate the d3 chart each time there's a prop change - react according to what's changed
 * wrap with error boundary
 * cancel subscriptions (also not done well for tree + map)
 * decide on JSON format
 * test json with geo-res none of which have lat-longs
 */

@connect((state) => {
  return {
    branchLengthsToDisplay: state.controls.branchLengthsToDisplay,
    absoluteDateMin: state.controls.absoluteDateMin,
    absoluteDateMax: state.controls.absoluteDateMax,
    nodes: state.tree.nodes,
    nodeColors: state.tree.nodeColors,
    visibility: state.tree.visibility,
    metadata: state.metadata,
    geoResolution: state.controls.geoResolution,
    dateMinNumeric: state.controls.dateMinNumeric,
    dateMaxNumeric: state.controls.dateMaxNumeric,
    colorBy: state.controls.colorScale.colorBy,
    pieChart: (
      !state.controls.colorScale.continuous &&                           // continuous color scale = no pie chart
      state.controls.geoResolution !== state.controls.colorScale.colorBy // geo circles match colorby == no pie chart
    ),
    legendValues: state.controls.colorScale.legendValues,
    showTransmissionLines: state.controls.showTransmissionLines
  };
})
class States extends React.Component {
  constructor(props) {
    super(props);
    this.svgDomRef = null;
    this.simulation = null; // not in `this.state` as we want no updates to occur
  }
  redraw(props) {
    // prototype. Recreate data every update & redraw.
    const {demeData, demeIndices, transmissionData, transmissionIndices, demeMultiplier} = setUpDataStructures(props); // eslint-disable-line
    console.log("redraw()");
    // console.log("demeData", demeData);
    // console.log("demeIndices", demeIndices);
    // console.log("transmissionData", transmissionData);
    // console.log("transmissionIndices", transmissionIndices);
    if (this.simulation) this.simulation.stop();
    const svg = select(this.svgDomRef);
    svg.selectAll("*").remove();
    this.simulation = drawDemesAndTransmissions({svg, demeData, transmissionData, demeMultiplier, ...props});
  }
  componentDidMount() {
    // console.log("\n\n----------CDM-------------");
    this.redraw(this.props);
  }
  componentWillReceiveProps(nextProps) {
    // console.log("\n\n----------CWRP-------------");
    this.redraw(nextProps);
  }

  render() {
    const { t } = this.props;
    return (
      <Card center title={t("Node States")}>
        {this.props.legend && (
          <ErrorBoundary>
            <Legend right width={this.props.width} />
          </ErrorBoundary>
        )}
        <svg
          id="NodeStatesGraph"
          style={{pointerEvents: "auto", cursor: "default", userSelect: "none"}}
          width={this.props.width}
          height={this.props.height}
          ref={(c) => {this.svgDomRef = c;}}
        />
      </Card>
    );
  }

}

function setUpDataStructures(props) {
  const locationToVisibleNodes = getVisibleNodesPerLocation(props.nodes, props.visibility, props.geoResolution);
  const demeData = [];
  const demeIndices = []; // not useful since we never use triplicate for <States>
  const visibleTips = props.nodes[0].tipCount;
  const demeMultiplier =
    demeCountMultiplier /
    Math.sqrt(_max([Math.sqrt(visibleTips * props.nodes.length), demeCountMinimum]));

  Object.entries(locationToVisibleNodes).forEach(([location, visibleNodes], index) => {
    const deme = {
      name: location,
      count: visibleNodes.length
    };
    deme.x = props.width/2;
    deme.y = props.height/2;
    if (props.pieChart) {
      /* create the arcs for the pie chart. NB `demeDataIdx` is the index of the deme in `demeData` where this will be inserted */
      deme.arcs = createOrUpdateArcs(visibleNodes, props.legendValues, props.colorBy, props.nodeColors);
      /* create back links between the arcs & which index of `demeData` they (will be) stored at */
      deme.arcs.forEach((a) => {
        a.demeDataIdx = index;
        a.outerRadius = Math.sqrt(deme.count)*demeMultiplier;
        a.parentDeme = deme;
      });
    } else {
      /* average out the constituent colours for a blended-colour circle */
      deme.color = getAverageColorFromNodes(visibleNodes, props.nodeColors);
    }
    demeData.push(deme);
    demeIndices[location] = [index];
  });

  const {transmissionData, transmissionIndices} = setUpTransmissions(
    props.showTransmissionLines,
    props.nodes,
    props.visibility,
    props.geoResolution,
    demeData,
    demeIndices,
    props.nodeColors
  );

  return {demeData, demeIndices, transmissionData, transmissionIndices, demeMultiplier};
}

function setUpTransmissions(showTransmissionLines, nodes, visibility, geoResolution, demeData, demeIndices, nodeColors) {
  /* similar to the <Map>'s setupTransmissionData */
  const transmissionData = []; /* edges, animation paths */
  const transmissionIndices = {}; /* map of transmission id to array of indices. Only used for updating? */
  const demeToDemeCounts = {}; /* Used to ompute the "extend" so that curves don't sit on top of each other */

  if (!showTransmissionLines) return {transmissionData, transmissionIndices};

  /* loop through nodes and compare each with its own children to get A->B transmissions */
  const genotype = isColorByGenotype(geoResolution);
  nodes.forEach((n) => {
    const nodeDeme = getTraitFromNode(n, geoResolution, {genotype});
    if (n.children) {
      n.children.forEach((child) => {
        const childDeme = getTraitFromNode(child, geoResolution, {genotype});
        if (nodeDeme && childDeme && nodeDeme !== childDeme) {

          // Keep track of how many we've seen from A->B in order to get a curve's "extend"
          if ([nodeDeme, childDeme] in demeToDemeCounts) {
            demeToDemeCounts[[nodeDeme, childDeme]] += 1;
          } else {
            demeToDemeCounts[[nodeDeme, childDeme]] = 1;
          }
          const extend = demeToDemeCounts[[nodeDeme, childDeme]];

          // compute a bezier curve
          // logic following the <Map>'s maybeConstructTransmissionEvent
          // console.log(`TRANSMISSION! ${nodeDeme} -> ${childDeme}, ${extend}`);
          const nodeCoords = {x: demeData[demeIndices[nodeDeme]].x, y: demeData[demeIndices[nodeDeme]].y};
          const childCoords = {x: demeData[demeIndices[childDeme]].x, y: demeData[demeIndices[childDeme]].y};
          const bezierCurve = bezier(nodeCoords, childCoords, extend);
          /* set up interpolator with origin and destination numdates */
          const nodeDate = getTraitFromNode(n, "num_date");
          const childDate = getTraitFromNode(child, "num_date");
          const interpolator = interpolateNumber(nodeDate, childDate);
          /* make a bezierDates array as long as bezierCurve */
          const bezierDates = bezierCurve.map((d, i) => {
            return interpolator(i / (bezierCurve.length - 1));
          });

          // following similar data structure same as in <Map>, should be able to cut down
          const transmission = {
            id: n.arrayIdx.toString() + "-" + child.arrayIdx.toString(),
            originNode: n,
            destinationNode: child,
            bezierCurve,
            bezierDates,
            originDeme: demeData[demeIndices[nodeDeme]],
            destinationDeme: demeData[demeIndices[childDeme]],
            originName: nodeDeme,
            destinationName: childDeme,
            originCoords: nodeCoords,
            destinationCoords: childCoords,
            originNumDate: nodeDate,
            destinationNumDate: childDate,
            color: nodeColors[n.arrayIdx], // colour given by *origin* node
            visible: visibility[child.arrayIdx] !== NODE_NOT_VISIBLE ? "visible" : "hidden", // transmission visible if child is visible
            extend: extend
          };
          transmissionData.push(transmission);
        }
      });
    }
  });

  transmissionData.forEach((transmission, index) => {
    if (!transmissionIndices[transmission.id]) {
      transmissionIndices[transmission.id] = [index];
    } else {
      transmissionIndices[transmission.id].push(index);
    }
  });

  return {transmissionData, transmissionIndices};
}


function updateTransmissionPositions(transmissionData) {
  transmissionData.forEach((transmission) => {
    // recomputing the entire curve isn't the smartest way to do it, but it is the simplest
    transmission.bezierCurve = bezier(
      {x: transmission.originDeme.x, y: transmission.originDeme.y},
      {x: transmission.destinationDeme.x, y: transmission.destinationDeme.y},
      transmission.extend
    );
  });
}


function drawDemesAndTransmissions({
  svg,
  demeData,
  transmissionData,
  demeMultiplier,
  dateMinNumeric,
  dateMaxNumeric,
  pieChart, /* bool */
  geoResolution,
  dispatch
}) {
  const width = +svg.attr("width");
  const height = +svg.attr("height");
  const simulation = forceSimulation()
    // .force("link", forceLink().id((d) => d.id))
    .force("charge", forceManyBody().strength(-10)); // must parameterise strength
    // .force("center", forceCenter(width / 2, height / 2)); // mean of all nodes is in center of SVG

  /* To do -- de-duplicate as much as possible via d3.call etc */
  let demes;
  if (pieChart) {
    demes = svg.append("g")
      .attr("class", "state_nodes")
      .selectAll("circle")
      .data(demeData)
      .enter()
        .append("g")
        .attr("class", "pie")
        .selectAll("arc")
        .call(d3drag()
          .on("start", dragstarted)
          .on("drag", dragged)
          .on("end", dragended)
        )
        .data((deme) => deme.arcs)
        .enter()
          .append("path")
          .attr("d", (d) => arc()(d))
          /* following calls are (almost) the same for pie charts & circles */
          .style("stroke", "none")
          .style("fill-opacity", 0.65)
          .style("fill", (d) => { return d.color; })
          .style("pointer-events", "all")
          .attr("transform", (d) =>
            "translate(" + demeData[d.demeDataIdx].x + "," + demeData[d.demeDataIdx].y + ")"
          )
          .on("mouseover", (d) => { dispatch(updateTipRadii({geoFilter: [geoResolution, demeData[d.demeDataIdx].name]})); })
          .on("mouseout", () => { dispatch(updateTipRadii()); })
          .call(d3drag()
            .on("start", dragstartedPie)
            .on("drag", draggedPie)
            .on("end", dragendedPie)
          );
  } else {
    demes = svg.append("g")
    .attr("class", "demes_circles")
    .selectAll("circle")
    .data(demeData)
    .enter()
    .append("circle")
    .attr("r", (d) => { return demeMultiplier * Math.sqrt(d.count); })
    /* following calls are (almost) the same for pie charts & circles */
    .style("stroke", "none")
    .style("fill-opacity", 0.65)
    .style("fill", (d) => { return d.color || "black"; })
    .style("stroke-opacity", 0.85)
    .style("stroke", (d) => { return d.color || "black"; })
    .style("pointer-events", "all")
    .attr("transform", (d) => "translate(" + d.x + "," + d.y + ")")
    .on("mouseover", (d) => { dispatch(updateTipRadii({geoFilter: [geoResolution, d.name]})); })
    .on("mouseout", () => { dispatch(updateTipRadii()); })
    .call(d3drag()
      .on("start", dragstarted)
      .on("drag", dragged)
      .on("end", dragended)
    );
  }

  const labels = svg.append("g")
    .attr("class", "labels")
    .selectAll("text")
    .data(demeData)
    .enter()
      .append("text")
      .attr("x", (d) => d.x + 10)
      .attr("y", (d) => d.y)
      .text((d) => d.name)
      .attr("class", "tipLabel")
      .style("font-size", "12px");

  const transmissions = svg.append("g")
    .attr("class", "transmissions")
    .selectAll("transmissions")
    .data(transmissionData)
    .enter()
    .append("path") /* instead of appending a geodesic path from the leaflet plugin data, we now draw a line directly between two points */
    .attr("d", (d) => renderBezier(d, dateMinNumeric, dateMaxNumeric))
    .attr("fill", "none")
    .attr("stroke-opacity", 0.6)
    .attr("stroke-linecap", "round")
    .attr("stroke", (d) => { return d.color; })
    .attr("stroke-width", 1);

  simulation
    .nodes(demeData) // will initialise index, x, y, vx & vy on objects in `demeData`
    .on("tick", () => {
      if (pieChart) {
        demes
          // to do -- stop arcs going outside visible SVG (Loop over `demeData` instead of using chained d3 call?)
          .attr("transform", (d) => "translate(" + d.parentDeme.x + "," + d.parentDeme.y + ")");
      } else {
        demes
          .each((d) => { // stop the simulation pushing things outside the visible SVG
            const pad = 20;
            if (d.x<pad) d.x=pad;
            if (d.x>(width-pad)) d.x=width-pad;
            if (d.y<pad) d.y=pad;
            if (d.y>(width-pad)) d.y=height-pad;
          })
          .attr("transform", (d) => "translate(" + d.x + "," + d.y + ")");
      }
      labels
        .attr("x", (d) => d.x)
        .attr("y", (d) => d.y);
      updateTransmissionPositions(transmissionData);
      transmissions
        .attr("d", (d) => renderBezier(d, dateMinNumeric, dateMaxNumeric));
    });


  function dragstarted(d) {
    if (!d3event.active) {
      simulation.alphaTarget(0.3).restart();
    }
    d.fx = d.x;
    d.fy = d.y;
  }

  function dragged(d) {
    d.fx = d3event.x;
    d.fy = d3event.y;
  }

  function dragended(d) {
    if (!d3event.active) {
      simulation.alphaTarget(0);
    }
    d.fx = null;
    d.fy = null;
  }

  /* pie chart drag functions are subtly different. Combine function with above! */
  function dragstartedPie(d) {
    if (!d3event.active) {
      simulation.alphaTarget(0.3).restart();
    }
    d.parentDeme.fx = d.parentDeme.x;
    d.parentDeme.fy = d.parentDeme.y;
  }

  function draggedPie(d) {
    d.parentDeme.fx = d3event.x;
    d.parentDeme.fy = d3event.y;
  }

  function dragendedPie(d) {
    if (!d3event.active) {
      simulation.alphaTarget(0);
    }
    d.parentDeme.fx = null;
    d.parentDeme.fy = null;
  }

  return simulation;
}

/* function to generate the path (the "d" attr) */
function renderBezier(d, numDateMin, numDateMax) {
  return pathStringGenerator(
    extractLineSegmentForAnimationEffect(
      numDateMin,
      numDateMax,
      d.originCoords,
      d.destinationCoords,
      d.originNumDate,
      d.destinationNumDate,
      d.visible,
      d.bezierCurve,
      d.bezierDates
    )
  );
}

const WithTranslation = withTranslation()(States);
export default WithTranslation;
