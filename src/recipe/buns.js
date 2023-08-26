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
    <tools>
        
    </tools>
    <tasks>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="0.5" unit="liters"/>
                </option>
            </options>
            <tools>
                <tool ref="bowl"/>
                <!-- TODO: 
                When selecting the bowl, how to know how big it should be?
                Perhaps it would be best to just define the right size and scale according to the recipe multiplier?
                This however would need to take into account the sizes of available bowls and when the dough is raised
                the bowl should be considerably larger than the volume of the dough. If the size of the dough
                would be larger than the largest bowl then there needs to be multiple bowls used. 
                -->
            </tools>
            <inputs>
                <input ref="milk"/>
            </inputs>
            <outputs>
                <output id="0.5l-milk" name="milk"/>
            </outputs>
        </task>
        <task operation="measure">
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
        </task>
        <task operation="measure">
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
        </task>
        <task operation="measure">
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
        </task>
        <task operation="measure">
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
        </task>
        <task operation="measure">
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
        </task>
        <task operation="measure">
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
        </task>
        <task operation="heat">
            <options>
                <option name="temperature">
                    <numeric-value number="30" unit="celsius"/>
                </option>
            </options>
            <tools>
                <tool ref="microwave"/>
                <!-- TODO: Would it be difficult to defer from the use of a microwave that the bowl cannot be metallic? -->
            </tools>
            <inputs>
                <input ref="0.5l-milk"/>
            </inputs>
            <outputs>
                <output id="warm-milk" name="warm milk"/>
            </outputs>
        </task>
        <join>
            <!-- TODO: preprocess the recipe and replace join with a task that combines the tasks inside it -->
            <!-- i.e. here the output would be a task that would get the timeline from crumble and incorporate and
                 also join the instructions.
                 Will the instructions be clear enough though? Perhaps in here, but is that universal? 
                 What should the instruction be here? Crumble yeast *and* mix *crumbled* yeast into the warm milk?
                 A more natural way would be to say to crumble the yeast into the milk and mix it --> 
            <task operation="crumble">
                <inputs>
                    <input ref="50g-yeast"/>
                </inputs>
                <outputs>
                    <output id="crumbled-yeast" name="crumbled yeast"/>
                </outputs>
            </task>
            <task operation="incorporate">
                <inputs>
                    <input ref="warm-milk"/>
                    <input ref="crumbled-yeast"/>
                </inputs>
                <outputs>
                    <output id="milk+yeast" name="milk and yeast"/>
                </outputs>
            </task>
        </join>
        <task operation="incorporate">
            <inputs>
                <input ref="milk+yeast"/>
                <input ref="egg-for-dough"/>
                <input ref="500g-sugar"/>
                <input ref="50g-cardamom"/>
            </inputs>
            <outputs>
                <output id="wet-mix" name="wet mix"/>
            </outputs>
        </task>
        <task operation="mix-in-steps">
            <options>
                <option name="task-size">
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
        </task>
        <task operation="incorporate">
            <inputs>
                <input ref="dough-without-butter"/>
                <input ref="200g-butter"/>
            </inputs>
            <outputs>
                <output id="dough" name="dough"/>
            </outputs>
        </task>
        <task operation="raise">
            <!-- multiplier for volume? would need to somehow calculate the volume of the dough from the ingredients -->
            <options>
                <option name="duration">
                    <numeric-value number="20" unit="minutes"/> <!-- time calculation from the multiplier? -->
                </option>
                <option name="multiplier">
                    <numeric-value number="200" unit="percent"/>
                </option>
                <option name="temperature">
                    <numeric-value number="30" unit="celcius"/>
                </option>
            </options>
            <tools>
                <tool ref="towel"/>
                <!-- TODO: how to refer to the towel from the instructions? -->
            </tools>
            <inputs>
                <input ref="dough"/>
            </inputs>
            <outputs>
                <output id="raised-dough" name="raised dough"/>
                <!-- TODO: should there be a timer output? -->
            </outputs>
        </task>
        <!-- TODO: is this a good way to express this?
        Would need to somehow be able to express that there are multiple batches produced, which can then be processed
        in parallel + processing can start when the first batch is ready 
        -->
        
        <!-- 
        There would need to be a calculation of what utilities are available to know how many batches could be
        processed in parallel.
        When going back from the end result, it is not possible to know how many batches should be created as the
        inputs have not been calculated yet. Perhaps another pass in the opposite direction is needed i.e. start
        from the "branches" calculating the grams and when encountering a batch operation, calculate how many
        batches should be created.
        Would it though be possible to define a certain formula for the recipe that would define the amount of 
        batches? i.e. 1kg dough would result in 4 batches (i.e. sheets) of 20 buns. Scaling the dough would scale
        the amount of batches proportionally as would scaling the sheet size.  
        -->
        <task operation="measure">
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
        </task>
        <task operation="beat">
            <inputs>
                <input ref="egg-for-brushing"/>
            </inputs>
            <outputs>
                <output id="beaten-egg" name="beaten egg"/>
            </outputs>
        </task>

        <task operation="split">
            <options>
                <option name="unit-size">
                    <!-- TODO: would it be better to just express this as number of batches? -->
                    <!-- The recipe will anyway be defined with as certain amounts instead of ratios -->
                    <!-- although it would be great if the batches could be weighed. Perhaps however the
                    best thing would be to define the size and amount of the outputs, which would define
                    the batch sizes. The problem there however is that it might be difficult to estimate
                    the amount of buns that fit on a single sheet. Perhaps it would be possible to define
                    some kind of bun size to sheet area mapping still and have that scale logarithmically
                    (or exponentially)? 
                    -->
                    <numeric-value number="30" unit="grams"/>
                </option>
            </options>
            <inputs>
                <input ref="raised-dough" />
            </inputs>
            <outputs>
                <output id="single-bun-dough" name="dough for bun" /><!-- TODO: replace: (batch of) dough for (single) bun -->
            </outputs>
        </task>
        <task operation="line"> <!-- line -> combine? -->
            <tools>
                <tool id="baking-sheet" />
            </tools>
            <inputs>
                <input id="parchment-paper" />
            </inputs>
            <outputs>
                <output id="lined-baking-sheet" />
            </outputs>
        </task>
        <task operation="batch">
            <inputs>
                <input id="single-bun-dough" />
                <input id="lined-baking-sheet" />
            </inputs>
            <tasks>
                <task operation="spherify">
                    <inputs>
                        <input ref="single-bun-dough"/>
                    </inputs>
                    <outputs>
                        <output id="dough-sphere" name="dough sphere"/>
                    </outputs>
                </task>
                <task operation="place-on-sheet"> <!-- add batch size limit here? -->
                    <tools>
                        <tool ref="sheet"/>
                    </tools>
                    <inputs>
                        <input ref="dough-sphere"/>
                    </inputs>
                    <outputs>
                        <output id="bun-on-sheet" name="bun on sheet"/>
                    </outputs>
                </task>
                <task operation="brush">
                    <inputs>
                        <input ref="bun-on-sheet"/>
                        <input ref="beaten-egg"/>
                    </inputs>
                    <outputs>
                        <output id="brushed-bun" name="brushed bun"/>
                    </outputs>
                </task>
                <!-- TODO: how to calculate this in the shopping list? -->
                <task operation="sprinkle">
                    <inputs>
                        <input ref="brushed-bun"/>
                        <input ref="pearl-sugar"/>
                    </inputs>
                    <outputs>
                        <output id="oven-ready-bun" name="oven ready bun"/>
                    </outputs>
                </task>
            </tasks>
            <outputs>
                <output id="oven-ready-bun-batch" />
            </outputs>
        </task>

        <task operation="bake"> <!-- continue when previous have finished. get end signal from previous steps? -->
            <!-- TODO: 
            add a sequence meta task, that takes the inputs of the parent task and forwards those to the first task, of which outputs will be the inputs of the next one. 
            How will the next tasks know which inputs to use though? Need to generate automatic ids and expect a certain order? -->
            <!-- TODO: 
            add interrupt i.e. suspend other operations when this finishes and split their processing time 
            -->
            <options>
                <option name="temperature">
                    <numeric-value number="250" unit="celcius"/>
                </option>
                <option name="duration">
                    <numeric-value number="15" unit="minutes"/>
                </option>
            </options>
            <tools>
                <tool ref="oven"/>
            </tools>
            <inputs>
                <input ref="oven-ready-bun-batch"/>
            </inputs>
            <outputs>
                <output id="baked-bun-batch" name="baked buns"/>
            </outputs>
        </task>
    </tasks>
</recipe>`;

export default xml_data;
