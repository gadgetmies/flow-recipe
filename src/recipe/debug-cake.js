// language=XML
const xml_data = `<?xml version="1.0" encoding="utf-8" ?>
<recipe ref="https://www.wearesovegan.com/epic-microwave-chocolate-cake/">
    <title>Epic Microwave Chocolate Cake</title>
    <ingredients>
        <ingredient id="soya-milk" name="soya milk"/>
        <ingredient id="dark-chocolate" name="dark chocolate"/>
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
        <task operation="mix">
            <instructions>
                Combine the
                <input ref="measured-soya-milk"/>
                and
                <input ref="dark-chocolate-for-base"/>
                in a
                <tool ref="bowl" reserved="true"/>.
                Set to side so it turns into
                <output id="dough" name="vegan buttermilk"/> <!-- TODO: is a spatula needed? -->
            </instructions>
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
                into the mould
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
        <task operation="fill">
            <instructions>
                Place a
                <input ref="baked-cake">the cake and rack</input>
                on top of a <!-- TODO: need for a way to reference specific parts of a split? -->
                <tool ref="tray"/>
                to collect the ganache glaze which will run down the sides of the cake.
                Spread the foo
                over the top of the cake and place a second
                <input ref="baked-cake">cake</input>
                on top. Make sure the cake remains on top of a cooling rack.
            </instructions>
            <outputs>
                <output id="filled-cake" name="filled cake"/>
                <tool ref="spatula"/>
            </outputs>
        </task>
    </tasks>
</recipe>`

export default xml_data
