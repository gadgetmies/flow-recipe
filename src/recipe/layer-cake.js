// language=XML
const xml_data = `<?xml version="1.0" encoding="utf-8" ?>
<recipe ref="https://www.wearesovegan.com/epic-microwave-chocolate-cake/">
    <title>Epic Microwave Chocolate Cake</title>
    <ingredients>
        <ingredient id="soya-milk" name="soya milk"/>
        <ingredient id="cider-vinegar" name="cider vinegar"/>
        <ingredient id="dark-chocolate" name="dark chocolate"/>
        <ingredient id="instant-coffee" name="instant coffee"/>
        <ingredient id="oil" name="vegetable oil"/>
        <ingredient id="flour" name="flour"/>
        <ingredient id="baking-powder" name="baking powder"/>
        <ingredient id="bicarb-of-soda" name="bicarb of soda"/>
        <ingredient id="cocoa-powder" name="cocoa powder"/>
        <ingredient id="caster-sugar" name="caster sugar"/>
        <ingredient id="vanilla-extract" name="vanilla extract"/>
        <ingredient id="vegan-cream" name="vegan cream"/>
        <ingredient id="margarine" name="margarine"/>
        <ingredient id="vegetable-oil" name="vegetable oil"/>
        <ingredient id="apple-cider-vinegar" name="apple cider vinegar"/>
    </ingredients>
    <tools>
        <tool id="silicone-cake-mould" name="silicone cake mould">
            <properties>
                <property name="circumference">
                    <numeric-value number="20" unit="centimeters"/>
                </property>
            </properties>
        </tool>
        <tool id="microwave-safe-jug" name="microwave safe jug"/>
        <tool id="spatula" name="spatula"/>
        <tool id="bowl" name="bowl"/>
        <tool id="parchment-paper" name="parchment paper"/>
        <tool id="frosting-spatula" name="frosting spatula"/>
        <tool id="grater" name="grater"/>
        <tool id="cooling-rack" name="cooling rack"/>
        <tool id="fridge" name="fridge"/>
        <tool id="precision-scale" name="precision scale"/>
        <tool id="kitchen-scale" name="kitchen scale"/>
        <tool id="plate" name="plate"/>
    </tools>
    <tasks>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="300" unit="ml"/>
                </option>
            </options>
            <tools>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="soya-milk"/>
            </inputs>
            <outputs>
                <output id="measured-soya-milk" name="soya milk"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="1" unit="tbsp"/>
                </option>
            </options>
            <tools>
                <tool ref="precision-scale"/>
            </tools>
            <inputs>
                <input ref="apple-cider-vinegar"/>
            </inputs>
            <outputs>
                <output id="measured-apple-cider-vinegar" name="apple cider vinegar"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="100" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="dark-chocolate"/>
            </inputs>
            <outputs>
                <output id="dark-chocolate-for-base" name="dark chocolate for base"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="1" unit="tbsp"/>
                </option>
            </options>
            <tools>
                <tool ref="precision-scale"/>
            </tools>
            <inputs>
                <input ref="instant-coffee"/>
            </inputs>
            <outputs>
                <output id="measured-instant-coffee" name="instant coffee"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="200" unit="ml"/>
                </option>
            </options>
            <tools>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="vegetable-oil"/>
            </inputs>
            <outputs>
                <output id="measured-vegetable-oil" name="vegetable oil"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="220" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="flour"/>
            </inputs>
            <outputs>
                <output id="measured-flour" name="flour"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="1" unit="tsp"/>
                </option>
            </options>
            <tools>
                <tool ref="precision-scale"/>
            </tools>
            <inputs>
                <input ref="baking-powder"/>
            </inputs>
            <outputs>
                <output id="measured-baking-powder" name="baking powder"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="1" unit="tsp"/>
                </option>
            </options>
            <tools>
                <tool ref="precision-scale"/>
            </tools>
            <inputs>
                <input ref="bicarb-of-soda"/>
            </inputs>
            <outputs>
                <output id="measured-bicarb" name="bicarb of soda"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="4" unit="tbsp"/>
                </option>
            </options>
            <tools>
                <tool ref="precision-scale"/>
            </tools>
            <inputs>
                <input ref="cocoa-powder"/>
            </inputs>
            <outputs>
                <output id="measured-cocoa-powder" name="cocoa powder"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="250" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="caster-sugar"/>
            </inputs>
            <outputs>
                <output id="measured-caster-sugar" name="caster sugar"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="1" unit="tbsp"/>
                </option>
            </options>
            <tools>
                <tool ref="precision-scale"/>
            </tools>
            <inputs>
                <input ref="vanilla-extract"/>
            </inputs>
            <outputs>
                <output id="measured-vanilla-extract" name="vanilla extract"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="150" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="dark-chocolate"/>
            </inputs>
            <outputs>
                <output id="dark-chocolate-for-ganache" name="dark chocolate for ganache"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="100" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="vegan-cream"/>
            </inputs>
            <outputs>
                <output id="vegan-cream-for-ganache" name="vegan cream"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="200" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="vegan-cream"/>
            </inputs>
            <outputs>
                <output id="vegan-cream-for-glaze" name="vegan cream for glaze"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="200" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="dark-chocolate"/>
            </inputs>
            <outputs>
                <output id="chocolate-for-glaze" name="chocolate for glaze"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="100" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="dark-chocolate"/>
            </inputs>
            <outputs>
                <output id="chocolate-for-curls" name="chocolate for curls"/>
            </outputs>
        </task>

        <task operation="mix">
            <instructions>
                Combine the
                <input ref="measured-soya-milk"/>
                and
                <input ref="measured-apple-cider-vinegar"/>
                in a
                <tool ref="bowl" reserved="true"/>.
                Set to side so it turns into
                <output id="vegan-buttermilk" name="vegan buttermilk"/> <!-- TODO: is a spatula needed? -->
            </instructions>
        </task>
        <task operation="mix">
            <instructions>
                Add the<input ref="dark-chocolate-for-base"/>,
                <input ref="measured-instant-coffee"/>
                and
                <input ref="measured-vegetable-oil"/>
                into
                <tool ref="microwave-safe-jug" reserved="true"/>
            </instructions>
            <outputs>
                <output id="chocolate-coffee-oil-mixture" name="chocolate-cofee-oil -mixture"/>
            </outputs>
        </task>
        <task operation="heat">
            <options>
                <option name="temperature">
                    <numeric-value number="60" unit="celsius"/>
                </option>
                <option name="duration">
                    <numeric-value number="30" unit="seconds"/>
                </option>
            </options>
            <tools>
                <tool ref="microwave"/>
            </tools>
            <inputs>
                <input ref="chocolate-coffee-oil-mixture"/>
            </inputs>
            <outputs>
                <output id="heated-chocolate-coffee-oil-mixture" name="heated chocolate-cofee-oil -mixture"/>
            </outputs>
        </task>
        <task operation="mix">
            <instructions>
                Add the
                <input ref="measured-flour"/>,
                <input ref="measured-baking-powder"/>,
                <input ref="measured-bicarb"/>,
                <input ref="measured-cocoa-powder"/>
                and
                <input ref="measured-caster-sugar"/>
                to
                <tool ref="mixing-bowl" reserved="true"/>
                and stir with a
                <tool ref="spatula" reserved="true"/>.
            </instructions>
            <outputs>
                <output id="dry-ingredients-in-bowl" name="dry ingredients"/>
                <!-- TODO: somehow reference this in the instructions so that it will be evident what the next steps refer to -->
            </outputs>
        </task>
        <task operation="mix">
            <instructions>
                Add
                <input ref="heated-chocolate-coffee-oil-mixture"/>
                and
                <input ref="vegan-buttermilk"/>
                into the
                <input ref="dry-ingredients-in-bowl"/>.
                Add the
                <input ref="measured-vanilla-extract"/>
                and stir with the
                <tool ref="spatula"/>
                until smooth.
            </instructions>
            <outputs>
                <output id="dough" name="dough"/>
                <tool ref="bowl"/> <!-- TODO: need to be specific about which bowl is freed! -->
                <tool ref="microwave-safe-jug"/>
            </outputs>
        </task>

        <task operation="grease">
            <instructions>
                Grease the sides of the
                <tool ref="silicone-cake-mould"
                      reserved="true"/> <!-- this does not scale -> when increasing the output, the steps need to be multiplied -->
                with
                <input ref="margarine"/> <!-- TODO: specify amount? -->
                and line the base with <!-- TODO: this should be another task? -->
                <input ref="parchment-paper"/>.
            </instructions>
            <outputs>
                <output id="prepared-cake-mould" name="prepared cake mould"/>
            </outputs>
        </task>
        <task operation="split">
            <options>
                <option name="parts">
                    <numeric-value number="2"/>
                </option>
            </options>
            <inputs>
                <input ref="dough"/>
            </inputs>
            <tools>
                <tool ref="bowl" reserved="true"/>
            </tools>
            <outputs>
                <output id="split-dough-in-a-bowl" name="split dough"/>
            </outputs>
        </task>
        <task operation="pour">
            <instructions>
                Pour the
                <input ref="split-dough-in-a-bowl"/>
                into the
                <input ref="prepared-cake-mould">cake mould</input> <!-- TODO: this is a input, but also a tool, so which tag to use? -->
            </instructions>
            <outputs>
                <output id="dough-in-mould" name="dough in the mould"/>
                <tool ref="bowl" name="used bowl"/>
            </outputs>
        </task>
        <task operation="bake-in-microwave"> <!-- operation is identical to heat -->
            <instructions>
                Bake the
                <input ref="dough-in-mould"/>
                in the
                <tool ref="microwave"/>
                for
                <option name="duration">
                    <numeric-value number="6" unit="minutes"/>
                </option>
                or until a toothpick comes out clean.
            </instructions>
            <outputs>
                <output id="baked-cake" name="baked cake"/>
            </outputs>
        </task>
        <task operation="chill"><!-- should there be a combined take out -operation? -->
            <instructions>
                Cool the
                <input ref="baked-cake"/>
                for
                <option name="duration">
                    <numeric-value number="10" unit="minutes"/>
                </option>
                in the <tool ref="silicone-cake-mould">mould</tool>.
            </instructions>
            <outputs>
                <output id="cooled-cake-in-mould" name="cooled cake in mould"/>
            </outputs>
        </task>
        <task operation="separate">
            <instructions>
                Detach the
                <input ref="cooled-cake-in-mould">cooled cake</input>
                from the mould by running a
                <tool ref="spatula"/>
                around the edges. Turn out the cake from the mould onto a <!-- TODO: cannot refer to the cooled-cake-in-mould in this sentence as it would multiply the inputs -->
                <tool ref="cooling-rack"/>.
            </instructions>
            <outputs>
                <output id="cake-on-the-rack" name="cake on the rack"/>
                <tool ref="silicone-cake-mould" name="used cake mould"/>
            </outputs>
        </task>
        <task operation="chill">
            <inputs>
                <input ref="cake-on-the-rack"/>
            </inputs>
            <options>
                <option name="duration">
                    <numeric-value number="2" unit="minutes"/> <!-- TODO: use temperature instead -->
                </option>
            </options>
            <outputs>
                <output id="cooled-cake-on-the-rack" name="cooled cake on the rack"/>
            </outputs>
        </task>
        <task operation="mix">
            <instructions>
                Add the
                <input ref="dark-chocolate-for-ganache"/>
                and
                <input ref="vegan-cream-for-ganache"/>
                to the
                <tool ref="microwave-safe-jug" reserved="true"/>
            </instructions>
            <outputs>
                <output id="chocolate-cream-mix" name="chocolate-cream -mix"/>
            </outputs>
        </task>
        <task operation="melt">
            <instructions>
                Melt
                <input ref="chocolate-cream-mix"/>
                for
                <option name="duration">
                    <numeric-value number="30" unit="seconds"/>
                </option>
                in the
                <tool ref="microwave"/>.
            </instructions>
            <outputs>
                <output id="melted-chocolate-and-cream-mix" name="melted chocolate and cream mix"/>
            </outputs>
        </task>
        <task operation="stir">
            <instructions>
                Stir the
                <input ref="melted-chocolate-and-cream-mix"/>
                with a
                <tool ref="spatula" reserved="true"/>
                until fully melted
            </instructions>
            <outputs>
                <output id="fully-melted-chocolate-and-cream-mix" name="fully melted chocolate and cream mix"/>
            </outputs>
        </task>
        <task operation="chill">
            <instructions>
                Cool the
                <input ref="fully-melted-chocolate-and-cream-mix"/>
                until at
                <option name="duration">
                    <numeric-value number="5" unit="minutes"/> <!-- TODO: use temperature instead -->
                </option>
            </instructions>
            <outputs>
                <output id="room-temperature-chocolate-cream-mix" name="room temperature chocolate-cream -mix"/>
            </outputs>
        </task>
        <task operation="chill">
            <instructions>
                Pop the
                <input ref="room-temperature-chocolate-cream-mix"/>
                into the
                <tool ref="fridge"/>
                and cool until it is
                <option name="duration">
                    <numeric-value number="5" unit="minutes"/>
                </option>
                <!-- TODO
                <option name="temperature">
                    <numeric-value number="10" unit="celsius">
                        runny enough to easily spread, but thick enough, so it doesn't fall down the sides of the cake
                    </numeric-value>
                </option>
                -->
            </instructions>
            <outputs>
                <output id="ganache" name="ganache"/>
            </outputs>
        </task>
        <task operation="fill">
            <instructions>
                Place a
                <input ref="cooled-cake-on-the-rack">the cake and rack</input>
                on top of a <!-- TODO: need for a way to reference specific parts of a split? -->
                <tool ref="tray"/>
                to collect the ganache glaze which will run down the sides of the cake.
                Spread the
                <input ref="ganache"/>
                over the top of the cake and place a second
                <input ref="cooled-cake-on-the-rack">cake</input>
                on top. Make sure the cake remains on top of a cooling rack.
            </instructions>
            <outputs>
                <output id="filled-cake" name="filled cake"/>
                <tool ref="spatula"/>
            </outputs>
        </task>
        <task operation="mix">
            <instructions>
                Add the
                <input ref="chocolate-for-glaze"/>
                and
                <input ref="vegan-cream-for-glaze"/>
                to a
                <input ref="microwave-safe-jug"/>
            </instructions>
            <outputs>
                <output id="chocolate-and-cream-for-glaze" name="chocolate and cream for glaze"/>
            </outputs>
        </task>
        <task operation="heat">
            <instructions>
                Heat the
                <input ref="chocolate-and-cream-for-glaze"/>
                for
                <option name="duration"><!-- TODO: use temperature in recipe, but print out time? -->
                    <numeric-value number="30" unit="seconds"/>
                </option>
                in the<tool ref="microwave"/>.
            </instructions>
            <outputs>
                <output id="heated-chocolate-and-cream-for-glaze" name="heated chocolate and cream for glaze"/>
            </outputs>
        </task>
        <task operation="mix">
            <instructions>
                Stir the
                <input ref="heated-chocolate-and-cream-for-glaze"/>
                until fully melted.
            </instructions>
            <outputs>
                <output id="melted-chocolate-and-cream-mix-for-glaze" name="melted chocolate and cream mix"/>
            </outputs>
        </task>
        <task operation="chill">
            <instructions>
                Leave the
                <input ref="melted-chocolate-and-cream-mix-for-glaze"/>
                to sit for
                <option name="duration">
                    <numeric-value number="10" unit="minutes"/>
                </option>
                so that it thickens a bit. The consistency should be
                <option name="temperature">
                    <numeric-value number="30" unit="celsius">runny enough so it pours down the side of the cake, but
                        thick
                        enough, so it covers the cake easily.
                    </numeric-value>
                </option>
            </instructions>
            <outputs>
                <output id="glaze" name="glaze"/>
            </outputs>
        </task>
        <task operation="spread">
            <instructions>
                Pour the
                <input ref="glaze"/>
                over the
                <input ref="filled-cake"/>
                and use a
                <tool ref="frosting-spatula"/>
                to ease the chocolate around the sides.
            </instructions>
            <outputs>
                <output id="frosted-cake" name="frosted cake"/>
            </outputs>
        </task>
        <task operation="transfer">
            <instructions>
                Transfer the
                <input ref="frosted-cake"/>
                onto a<tool ref="plate"/>.
            </instructions>
            <outputs>
                <output id="cake-on-plate" name="cake on a plate"/>
                <tool ref="cooling-rack" reusable="true"/>
            </outputs>
        </task>
        <task operation="grate">
            <inputs>
                <input ref="chocolate-for-curls"/>
            </inputs>
            <tools>
                <tool ref="grater"/>
                <tool ref="bowl"/>
            </tools>
            <outputs>
                <output id="chocolate-curls" name="chocolate curls"/>
            </outputs>
        </task>
        <task operation="sprinkle">
            <instructions>
                Sprinkle
                <input ref="chocolate-curls"/>
                on top of the
                <input ref="cake-on-plate"/>
            </instructions>
            <outputs>
                <output id="finished-cake" name="finished cake"/>
            </outputs>
        </task>
    </tasks>
</recipe>`

export default xml_data
