// language=XML
const xml_data = `<?xml version="1.0" encoding="utf-8" ?>
<recipe>
    <title>Buns</title>
    <ingredients>
        <ingredient id="milk" name="milk">
            <properties>
                <property name="fat-content">
                    <numeric-value number="3" unit="percent"/>
                </property>
            </properties>
        </ingredient>
        <ingredient id="yeast" name="yeast">
            <properties>
                <property name="type" value="dry"/>
            </properties>
        </ingredient>
        <ingredient id="egg" name="egg">
            <properties>
                <property name="size" value="medium"/>
            </properties>
        </ingredient>
        <ingredient id="salt" name="salt">
            <properties>
                <property name="type" value="fine"/>
            </properties>
        </ingredient>
        <ingredient id="sugar" name="sugar">
            <properties>
                <property name="type" value="white"/>
            </properties>
        </ingredient>
        <ingredient id="pearl-sugar" name="sugar">
            <properties>
                <property name="type" value="pearl"/>
            </properties>
        </ingredient>
        <ingredient id="cardamom" name="cardamom">
            <properties>
                <property name="type" value="ground"/>
            </properties>
        </ingredient>
        <ingredient id="flour" name="white bread flour"/>
        <ingredient id="butter" name="butter">
            <properties>
                <property name="salt-content">
                    <numeric-value number="11" unit="milligram"/>
                </property>
            </properties>
        </ingredient>
    </ingredients>
    <steps>
        <step operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="0.5" unit="liters"/>
                </option>
            </options>
            <inputs>
                <input ref="milk"/>
            </inputs>
            <outputs>
                <output id="0.5l-milk" name="milk"/>
            </outputs>
        </step>
        <step operation="measure">
            <options>
              <option name="amount">
                  <numeric-value number="50" unit="grams"/>
              </option>
            </options>
            <inputs>
                <input ref="yeast"/>
            </inputs>
            <outputs>
                <output id="50g-yeast" name="yeast"/>
            </outputs>
        </step>
        <step operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="500" unit="grams"/>
                </option>
            </options>
            <inputs>
                <input ref="sugar"/>
            </inputs>
            <outputs>
                <output id="500g-sugar" name="sugar"/>
            </outputs>
        </step>
        <step operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="50" unit="grams"/>
                </option>
            </options>
            <inputs>
                <input ref="cardamom"/>
            </inputs>
            <outputs>
                <output id="50g-cardamom" name="cardamom"/>
            </outputs>
        </step>
        <step operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="1" unit="pieces"/>
                </option>
            </options>
            <inputs>
                <input ref="egg"/>
            </inputs>
            <outputs>
                <output id="egg-for-dough" name="egg"/>
            </outputs>
        </step>
        <step operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="900" unit="grams"/>
                </option>
            </options>
            <inputs>
                <input ref="flour"/>
            </inputs>
            <outputs>
                <output id="flour-for-dough" name="flour"/>
            </outputs>
        </step>
        <step operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="200" unit="grams"/>
                </option>
            </options>
            <inputs>
                <input ref="butter"/>
            </inputs>
            <outputs>
                <output id="200g-butter" name="butter"/>
            </outputs>
        </step>
        <step operation="heat">
            <options>
                <option name="temperature">
                    <numeric-value number="30" unit="celsius"/>
                </option>
            </options>
            <inputs>
                <input ref="0.5l-milk"/>
            </inputs>
            <outputs>
                <output id="warm-milk" name="warm milk"/>
            </outputs>
        </step>
        <step operation="crumble">
            <inputs>
                <input ref="50g-yeast"/>
            </inputs>
            <outputs>
                <output id="crumbled-yeast" name="crumbled yeast"/>
            </outputs>
        </step>
        <step operation="mix">
            <inputs>
                <input ref="warm-milk"/>
                <input ref="crumbled-yeast"/>
            </inputs>
            <outputs>
                <output id="milk+yeast" name="milk and yeast"/>
            </outputs>
        </step>
        <step operation="mix">
            <inputs>
                <input ref="milk+yeast"/>
                <input ref="egg-for-dough"/>
                <input ref="500g-sugar"/>
                <input ref="50g-cardamom"/>
            </inputs>
            <outputs>
                <output id="wet-mix" name="wet mix"/>
            </outputs>
        </step>
        <step operation="mix-in-steps">
            <options>
                <option name="step-size">
                    <numeric-value number="1" unit="deciliters"/>
                </option>
            </options>
            <inputs>
                <input ref="wet-mix"/>
                <input ref="flour-for-dough"/>
            </inputs>
            <outputs>
                <output id="dough-without-butter" name="dough"/>
            </outputs>
        </step>
        <step operation="mix">
            <!-- TODO: perhaps better operation name here would be "incorporate" when one of the inputs comes from a previous step -->
            <inputs>
                <input ref="dough-without-butter"/>
                <input ref="200g-butter"/>
            </inputs>
            <outputs>
                <output id="dough" name="dough"/>
            </outputs>
        </step>
        <step operation="raise">
            <options>
                <option name="duration">
                    <numeric-value number="20" unit="minutes"/>
                </option>
                <option name="temperature">
                    <numeric-value number="30" unit="celcius"/>
                </option>
            </options>
            <inputs>
                <input ref="dough"/>
            </inputs>
            <outputs>
                <output id="raised-dough" name="raised dough"/>
            </outputs>
        </step>
        <!-- TODO: is this a good way to express this?
         Would need to somehow be able to express that there are multiple batches produced, which can then be processed
         in parallel + processing can start when the first batch is ready -->
        <step operation="batch">
            <options>
                <option name="batch-size">
                    <numeric-value number="30" unit="grams"/>
                </option>
            </options>
            <inputs>
                <input ref="raised-dough"/>
            </inputs>
            <outputs>
                <output id="split-dough" name="split dough"/>
            </outputs>
        </step>
        <step operation="spherify">
            <inputs>
                <input ref="split-dough"/>
            </inputs>
            <outputs>
                <output id="dough-spheres" name="dough spheres"/>
            </outputs>
        </step>
        <step operation="place-on-sheet">
            <inputs>
                <input ref="dough-spheres"/>
            </inputs>
            <outputs>
                <output id="buns-on-sheet" name="buns on sheet"/>
            </outputs>
        </step>
        <step operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="1" unit="pieces"/>
                </option>
            </options>
            <inputs>
                <input ref="egg"/>
            </inputs>
            <outputs>
                <output id="egg-for-brushing" name="egg"/>
            </outputs>
        </step>
        <step operation="beat">
            <inputs>
                <input ref="egg-for-brushing"/>
            </inputs>
            <outputs>
                <output id="beaten-egg" name="beaten egg"/>
            </outputs>
        </step>
        <step operation="brush">
            <inputs>
                <input ref="buns-on-sheet"/>
                <input ref="beaten-egg"/>
            </inputs>
            <outputs>
                <output id="brushed-buns" name="brushed buns"/>
            </outputs>
        </step>
        <!-- TODO: how to calculate this in the shopping list? -->
        <step operation="sprinkle">
            <inputs>
                <input ref="brushed-buns"/>
                <input ref="pearl-sugar"/>
            </inputs>
            <outputs>
                <output id="oven-ready-buns" name="oven ready buns"/>
            </outputs>
        </step>
        <step operation="bake">
            <!-- TODO: add interrupt i.e. suspend other operations when this finishes and split their processing time -->
            <options>
                <option name="temperature">
                    <numeric-value number="250" unit="celcius"/>
                </option>
                <option name="duration">
                    <numeric-value number="15" unit="minutes"/>
                </option>
            </options>
            <inputs>
                <input ref="oven-ready-buns"/>
            </inputs>
            <outputs>
                <output id="baked-buns" name="baked buns"/>
            </outputs>
        </step>
    </steps>
</recipe>`;

export default xml_data;
